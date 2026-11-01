// Copyright 2026 The Breezer Authors
#include "chrome/browser/sync/breezer_sync/backend.h"

#include <algorithm>
#include <atomic>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/synchronization/waitable_event.h"
#include "base/time/time.h"
#include "chrome/browser/extensions/api/sync_vault_provider/sync_vault_provider_service.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/sync/breezer_sync/provider_transport.h"
#include "chrome/browser/sync/private_sync/private_sync_repository.h"
#include "chrome/browser/sync/sync_service_factory.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "components/prefs/pref_service.h"
#include "components/sync/engine/cancelation_signal.h"
#include "components/sync/engine/custom_sync_backend.h"
#include "components/sync/engine/loopback_server/loopback_server_state_delta.h"
#include "components/sync/engine/sync_vault/sync_vault_backend.h"
#include "components/sync/engine/sync_vault/sync_vault_cryptographer.h"
#include "components/sync/engine/sync_vault/sync_vault_store.h"
#include "components/sync/service/sync_service.h"
#include "content/public/browser/browser_thread.h"

namespace breezer_sync {
namespace {
namespace prefs = browser_sync::private_sync_prefs;
using Repository = browser_sync::private_sync::Repository;
using Service = extensions::SyncVaultProviderService;
Service* Provider(Profile* profile) {
  return extensions::SyncVaultProviderServiceFactory::GetForBrowserContext(profile);
}
bool SameIdentity(const prefs::Configuration& a, const prefs::Configuration& b) {
  return a.provider == b.provider && a.vault_uuid == b.vault_uuid &&
         a.encrypted_vault_key == b.encrypted_vault_key && a.key_mode == b.key_mode;
}
struct CheckpointWrite : base::RefCountedThreadSafe<CheckpointWrite> {
  base::WaitableEvent ready;
  bool persisted = false;
 private:
  friend class base::RefCountedThreadSafe<CheckpointWrite>;
  ~CheckpointWrite() = default;
};
struct CheckpointContext {
  std::atomic<syncer::CancelationSignal*> signal{nullptr};
};
// The engine must not acknowledge a new remote head until its local rollback
// checkpoint is durably protected. Stop waiting promptly when shutdown signals,
// including when UI is synchronously stopping that same engine.
bool PersistCheckpoint(base::WeakPtr<Profile> profile,
                       prefs::Configuration expected,
                       scoped_refptr<os_crypt_async::Encryptor> encryptor,
                       std::shared_ptr<CheckpointContext> context,
                       const syncer::SyncVaultCheckpoint& checkpoint) {
  auto bytes = syncer::SerializeSyncVaultCheckpoint(checkpoint);
  if (!bytes) return false;
  auto encrypted = encryptor->EncryptString(std::string(bytes->begin(), bytes->end()));
  if (!encrypted) return false;
  auto write = base::MakeRefCounted<CheckpointWrite>();
  content::GetUIThreadTaskRunner({})->PostTask(FROM_HERE, base::BindOnce(
      [](base::WeakPtr<Profile> profile, prefs::Configuration expected,
         std::vector<uint8_t> encrypted, scoped_refptr<CheckpointWrite> write) {
        if (!profile) { write->ready.Signal(); return; }
        auto* repository = Repository::Get(profile.get());
        if (!repository || !repository->configuration() ||
            !SameIdentity(*repository->configuration(), expected)) {
          write->ready.Signal(); return;
        }
        auto next = *repository->configuration();
        next.encrypted_checkpoint = std::move(encrypted);
        repository->InstallConfiguration(std::move(next));
        repository->Flush(base::BindOnce([](scoped_refptr<CheckpointWrite> write) {
          write->persisted = true; write->ready.Signal();
        }, write));
      }, profile, std::move(expected), std::move(*encrypted), write));
  const auto deadline = base::TimeTicks::Now() + base::Seconds(30);
  while (!write->ready.TimedWait(base::Milliseconds(50))) {
    auto* signal = context->signal.load();
    if (signal && signal->IsSignalled()) return false;
    if (base::TimeTicks::Now() >= deadline) return false;
  }
  return write->persisted;
}
class Backend final : public syncer::CustomSyncBackend {
 public:
  Backend(std::unique_ptr<syncer::SyncVaultStore> store,
          std::shared_ptr<CheckpointContext> context)
      : backend_(std::move(store)), context_(std::move(context)) {}
  std::unique_ptr<syncer::ServerConnectionManager> CreateConnectionManager(
      syncer::CancelationSignal* signal) override {
    context_->signal.store(signal);
    return backend_.CreateConnectionManager(signal);
  }
 private:
  syncer::SyncVaultBackend backend_;
  std::shared_ptr<CheckpointContext> context_;
};
}  // namespace

bool IsConfigured(Profile* profile) {
  return profile && !profile->IsOffTheRecord() && prefs::IsConfigured(*profile->GetPrefs());
}
syncer::CustomSyncBackendStatus GetBackendStatus(Profile* profile) {
  if (!IsConfigured(profile)) return syncer::CustomSyncBackendStatus::kFeatureDisabled;
  const auto configuration = prefs::ReadConfiguration(*profile->GetPrefs());
  if (prefs::HasBlockingReconciliationError(*profile->GetPrefs(), configuration->vault_uuid))
    return syncer::CustomSyncBackendStatus::kReconciliationBlocked;
  auto* service = Provider(profile);
  if (!service || !service->SelectProvider(configuration->provider.id) || !service->GetSelectedProvider())
    return syncer::CustomSyncBackendStatus::kProviderUnavailable;
  return syncer::CustomSyncBackendStatus::kEnabled;
}
std::string GetBackendNamespace(Profile* profile) {
  const auto configuration = profile ? prefs::ReadConfiguration(*profile->GetPrefs()) : std::nullopt;
  return configuration ? configuration->provider.id + "/" + configuration->vault_uuid : std::string();
}
std::unique_ptr<syncer::CustomSyncBackend> CreateBackend(
    Profile* profile, scoped_refptr<os_crypt_async::Encryptor> encryptor) {
  if (GetBackendStatus(profile) != syncer::CustomSyncBackendStatus::kEnabled || !encryptor)
    return nullptr;
  const auto configuration = *prefs::ReadConfiguration(*profile->GetPrefs());
  auto key = encryptor->DecryptData(configuration.encrypted_vault_key);
  auto encoded_checkpoint = encryptor->DecryptData(configuration.encrypted_checkpoint);
  if (!key || key->size() != syncer::SyncVaultCryptographer::kVaultKeySize || !encoded_checkpoint)
    return nullptr;
  auto checkpoint = syncer::ParseSyncVaultCheckpoint(base::as_byte_span(*encoded_checkpoint));
  if (!checkpoint || checkpoint->vault_uuid != configuration.vault_uuid) return nullptr;
  auto context = std::make_shared<CheckpointContext>();
  auto store = syncer::SyncVaultStore::Create(
      CreateProviderTransport(Provider(profile)->GetWeakPtr(), configuration.provider.id, configuration.vault_uuid),
      std::make_unique<syncer::LoopbackServerStateCodec>(), base::as_byte_span(*key),
      configuration.vault_uuid, *checkpoint,
      base::BindRepeating(&PersistCheckpoint, profile->GetWeakPtr(), configuration, encryptor, context));
  std::fill(key->begin(), key->end(), '\0');
  if (!store) return nullptr;
  return std::make_unique<Backend>(std::move(*store), std::move(context));
}
base::DictValue ReadStatus(Profile* profile) {
  base::DictValue status;
  status.Set("configured", IsConfigured(profile));
  auto* sync = profile ? SyncServiceFactory::GetForProfile(profile) : nullptr;
  status.Set("active", sync && sync->GetTransportState() == syncer::SyncService::TransportState::ACTIVE);
  const auto configuration = profile ? prefs::ReadConfiguration(*profile->GetPrefs()) : std::nullopt;
  if (configuration) {
    status.Set("providerId", configuration->provider.id);
    status.Set("vaultId", configuration->vault_uuid);
  }
  auto diagnostics = profile ? prefs::ReadDiagnostics(*profile->GetPrefs()) : std::nullopt;
  status.Set("hasError", diagnostics && diagnostics->last_error.has_value());
  if (diagnostics) {
    status.Set("lastSuccess", static_cast<double>(diagnostics->last_success.InMillisecondsSinceUnixEpoch()));
  }
  return status;
}
}  // namespace breezer_sync
