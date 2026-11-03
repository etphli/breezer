// Copyright 2026 The Breezer Authors
#include "chrome/browser/sync/breezer_sync/provider_transport.h"

#include <limits>
#include <utility>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/synchronization/waitable_event.h"
#include "base/task/single_thread_task_runner.h"
#include "base/threading/scoped_blocking_call.h"
#include "base/time/time.h"
#include "components/sync/engine/cancelation_signal.h"
#include "content/public/browser/browser_thread.h"

namespace breezer_sync {
namespace {
using Service = extensions::SyncVaultProviderService;
using Error = syncer::SyncVaultTransportError;
namespace api = extensions::api::sync_vault_provider;

Error MapError(api::SyncVaultProviderError error) {
  switch (error) {
    case api::SyncVaultProviderError::kAuthRequired: return Error::kAuthenticationRequired;
    case api::SyncVaultProviderError::kConflict: return Error::kConflict;
    case api::SyncVaultProviderError::kNetworkError: return Error::kNetworkError;
    case api::SyncVaultProviderError::kTemporaryError: return Error::kTemporaryError;
    case api::SyncVaultProviderError::kQuotaExceeded: return Error::kQuotaExceeded;
    case api::SyncVaultProviderError::kAccessDenied: return Error::kAccessDenied;
    case api::SyncVaultProviderError::kUnsupported: return Error::kUnsupported;
    case api::SyncVaultProviderError::kAborted: return Error::kAborted;
    default: return Error::kInvalidData;
  }
}

// Callback owns the result independently of the waiting engine. A cancelled
// engine can exit before UI handles a queued request or a provider replies.
class Reply : public base::RefCountedThreadSafe<Reply> {
 public:
  base::WaitableEvent ready;
  std::atomic<bool> abandoned{false};
  std::atomic<Service::RequestId> request_id{0};
  std::optional<Service::Response> response;
 private:
  friend class base::RefCountedThreadSafe<Reply>;
  ~Reply() = default;
};

class ProviderTransport final : public syncer::SyncVaultTransport {
 public:
  ProviderTransport(base::WeakPtr<Service> service, std::string provider,
                    std::string vault, std::shared_ptr<std::atomic<bool>> active)
      : ui_(content::GetUIThreadTaskRunner({})), service_(service),
        provider_(std::move(provider)), vault_(std::move(vault)), active_(std::move(active)) {}
  ~ProviderTransport() override { if (active_) active_->store(false); }

  void SetCancelationSignal(syncer::CancelationSignal* signal) override {
    signal_ = signal;
  }

  ReadResult ReadObject(const std::string& object, size_t maximum) override {
    if (maximum > static_cast<size_t>(std::numeric_limits<int>::max()))
      return base::unexpected(Error::kInvalidData);
    auto response = Call(base::BindOnce(
        [](std::string vault, std::string object, int maximum, Service* service,
           Service::ResponseCallback done) {
          return service->ReadObject(vault, object, maximum, std::move(done));
        }, vault_, object, static_cast<int>(maximum)));
    if (!response.has_value()) return base::unexpected(response.error());
    if (!response->has_value()) {
      if (response->error().error == api::SyncVaultProviderError::kNotFound)
        return std::nullopt;
      return base::unexpected(MapError(response->error().error));
    }
    auto& success = *response->value().success;
    if (!success.data || !success.revision || success.revision->empty() ||
        success.data->size() > maximum)
      return base::unexpected(Error::kInvalidData);
    return syncer::OpaqueSyncVaultObject{std::move(*success.data),
                                       std::move(*success.revision)};
  }

  WriteResult WriteObject(const std::string& object,
                          std::optional<std::string> revision,
                          std::vector<uint8_t> data,
                          std::optional<uint32_t> epoch) override {
    if (epoch && *epoch > static_cast<uint32_t>(std::numeric_limits<int>::max()))
      return base::unexpected(Error::kInvalidData);
    std::optional<int> retention;
    if (epoch) retention = static_cast<int>(*epoch);
    auto response = Call(base::BindOnce(
        [](std::string vault, std::string object, std::vector<uint8_t> data,
           std::optional<std::string> revision, std::optional<int> epoch,
           Service* service, Service::ResponseCallback done) {
          return service->WriteObject(vault, object, std::move(data), std::move(revision),
                               epoch, std::move(done));
        }, vault_, object, std::move(data), std::move(revision), retention));
    if (!response.has_value()) return base::unexpected(response.error());
    if (!response->has_value()) return base::unexpected(MapError(response->error().error));
    const auto& success = *response->value().success;
    if (!success.revision || success.revision->empty())
      return base::unexpected(Error::kInvalidData);
    return *success.revision;
  }

  void CollectEpochsBefore(uint32_t minimum, CollectCallback done) override {
    // Collection is optional. Retain old ciphertext until a separately tested
    // nonblocking provider collection adapter is available. Never block the
    // engine or risk collecting data from a different configuration.
    std::move(done).Run(base::unexpected(Error::kUnsupported));
  }

 private:
  using Request = base::OnceCallback<Service::RequestId(Service*, Service::ResponseCallback)>;
  base::expected<Service::Response, Error> Call(Request request) {
    CHECK(!content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
    if (signal_ && signal_->IsSignalled()) return base::unexpected(Error::kAborted);
    auto reply = base::MakeRefCounted<Reply>();
    ui_->PostTask(FROM_HERE, base::BindOnce(
        [](base::WeakPtr<Service> service, std::string provider,
           scoped_refptr<Reply> reply, Request request) {
          if (reply->abandoned.load() || !service || service->selected_provider_id() != provider) {
            reply->ready.Signal();
            return;
          }
          const auto request_id = std::move(request).Run(service.get(), base::BindOnce(
              [](scoped_refptr<Reply> reply, Service::Response response) {
                reply->response.emplace(std::move(response));
                reply->ready.Signal();
              }, reply));
          reply->request_id.store(request_id);
          if (reply->abandoned.load()) service->CancelRequest(request_id);
        }, service_, provider_, reply, std::move(request)));
    const auto abandon = [&] {
      reply->abandoned.store(true);
      ui_->PostTask(FROM_HERE, base::BindOnce(
          [](base::WeakPtr<Service> service, scoped_refptr<Reply> reply) {
            if (service) service->CancelRequest(reply->request_id.load());
          }, service_, reply));
    };
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    const auto deadline = base::TimeTicks::Now() + base::Minutes(3);
    while (!reply->ready.TimedWait(base::Milliseconds(50))) {
      if (signal_ && signal_->IsSignalled()) { abandon(); return base::unexpected(Error::kAborted); }
      if (base::TimeTicks::Now() >= deadline) { abandon(); return base::unexpected(Error::kTemporaryError); }
    }
    if (!reply->response) return base::unexpected(Error::kAborted);
    return std::move(*reply->response);
  }
  const scoped_refptr<base::SingleThreadTaskRunner> ui_;
  const base::WeakPtr<Service> service_;
  const std::string provider_;
  const std::string vault_;
  const std::shared_ptr<std::atomic<bool>> active_;
  raw_ptr<syncer::CancelationSignal> signal_ = nullptr;
};
}  // namespace

std::unique_ptr<syncer::SyncVaultTransport> CreateProviderTransport(
    base::WeakPtr<Service> service, std::string provider, std::string vault,
    std::shared_ptr<std::atomic<bool>> active) {
  return std::make_unique<ProviderTransport>(service, std::move(provider), std::move(vault), std::move(active));
}
}  // namespace breezer_sync
