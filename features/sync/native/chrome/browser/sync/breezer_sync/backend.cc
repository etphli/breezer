// Copyright 2026 The Breezer Authors
#include "chrome/browser/sync/breezer_sync/backend.h"
#include "chrome/browser/sync/breezer_sync/prefs.h"
#include "components/sync/base/pref_names.h"
#include "components/sync/base/data_type.h"

#include <algorithm>
#include <atomic>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/synchronization/waitable_event.h"
#include "base/threading/scoped_blocking_call.h"
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
#include "components/sync/service/sync_user_settings.h"
#include "components/sync/base/user_selectable_type.h"
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
  std::atomic<bool> abandoned{false};
 private:
  friend class base::RefCountedThreadSafe<CheckpointWrite>;
  ~CheckpointWrite() = default;
};
struct CheckpointContext {
  std::atomic<syncer::CancelationSignal*> signal{nullptr};
  const std::shared_ptr<std::atomic<bool>> active = std::make_shared<std::atomic<bool>>(true);
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
        if (write->abandoned.load() || !profile) { write->ready.Signal(); return; }
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
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  const auto deadline = base::TimeTicks::Now() + base::Seconds(30);
  while (!write->ready.TimedWait(base::Milliseconds(50))) {
    auto* signal = context->signal.load();
    if (signal && signal->IsSignalled()) { write->abandoned.store(true); return false; }
    if (base::TimeTicks::Now() >= deadline) { write->abandoned.store(true); return false; }
  }
  return write->persisted;
}
prefs::ReconciliationError DiagnosticError(syncer::SyncVaultStoreError error) {
  using E = syncer::SyncVaultStoreError;
  using D = prefs::ReconciliationError;
  switch (error) {
    case E::kAuthenticationRequired: return D::kAuthenticationRequired;
    case E::kConflict: return D::kConflict;
    case E::kNetworkError: return D::kNetwork;
    case E::kTemporaryError: return D::kTemporary;
    case E::kQuotaExceeded: return D::kQuotaExceeded;
    case E::kAccessDenied: return D::kAccessDenied;
    case E::kUnsupported: return D::kUnsupported;
    case E::kAborted: return D::kAborted;
    case E::kRollback: return D::kRollback;
    case E::kFork: return D::kFork;
    case E::kIncompleteHistory: return D::kIncompleteHistory;
    case E::kCheckpointPersistenceFailed: return D::kCheckpointPersistence;
    default: return D::kInvalidData;
  }
}
void ReportDiagnostics(base::WeakPtr<Profile> profile,
                       prefs::Configuration expected,
                       std::shared_ptr<std::atomic<bool>> active,
                       std::optional<syncer::SyncVaultStoreError> error,
                       const syncer::SyncVaultCheckpoint& checkpoint,
                       std::optional<syncer::SyncVaultStateDiagnostics> statistics) {
  prefs::Diagnostics result;
  result.vault_uuid = expected.vault_uuid;
  result.accepted_generation = checkpoint.generation;
  result.last_attempt = base::Time::Now();
  if (error) result.last_error = DiagnosticError(*error);
  else result.last_success = result.last_attempt;
  if (statistics) {
    result.state_statistics_available = true;
    result.entity_count = statistics->entity_count;
    result.state_bytes = statistics->state_bytes;
  }
  content::GetUIThreadTaskRunner({})->PostTask(FROM_HERE, base::BindOnce(
      [](base::WeakPtr<Profile> profile, prefs::Configuration expected, std::shared_ptr<std::atomic<bool>> active, prefs::Diagnostics result) {
        if (!active->load() || !profile) return;
        auto* repository = Repository::Get(profile.get());
        if (repository && repository->RecordReconciliation(expected, std::move(result))) {
          if (auto* sync = SyncServiceFactory::GetForProfile(profile.get())) sync->ReconfigureBackend();
        }
      }, profile, std::move(expected), std::move(active), std::move(result)));
}
class Backend final : public syncer::CustomSyncBackend {
 public:
  Backend(std::unique_ptr<syncer::SyncVaultStore> store,
          std::shared_ptr<CheckpointContext> context,
          syncer::SyncVaultDiagnosticsCallback diagnostics)
      : backend_(std::move(store), std::move(diagnostics)), context_(std::move(context)) {}
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

void PrepareProfile(Profile* profile) {
  // A local roaming backend is explicitly separate from the encrypted vault.
  // Never feed a retained vault workspace snapshot into its plain folder store.
  // The saved workspace and merge metadata stay in extension-local storage.
  if (profile && profile->GetPrefs()->GetBoolean(syncer::prefs::kEnableLocalSyncBackend))
    profile->GetPrefs()->ClearPref(kWorkspacePref);
}
bool IsConfigured(Profile* profile) {
  return profile && !profile->IsOffTheRecord() && !profile->IsGuestSession() &&
      !profile->GetPrefs()->GetBoolean(syncer::prefs::kEnableLocalSyncBackend) &&
      prefs::IsConfigured(*profile->GetPrefs());
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
  const auto local_failure = [&] {
    prefs::Diagnostics diagnostics;
    diagnostics.vault_uuid = configuration.vault_uuid;
    diagnostics.last_attempt = base::Time::Now();
    diagnostics.last_error = prefs::ReconciliationError::kCheckpointPersistence;
    if (auto* repository = Repository::Get(profile)) repository->RecordReconciliation(configuration, std::move(diagnostics));
  };
  auto key = encryptor->DecryptData(configuration.encrypted_vault_key);
  auto encoded_checkpoint = encryptor->DecryptData(configuration.encrypted_checkpoint);
  if (!key || key->size() != syncer::SyncVaultCryptographer::kVaultKeySize || !encoded_checkpoint) { local_failure(); return nullptr; }
  auto checkpoint = syncer::ParseSyncVaultCheckpoint(base::as_byte_span(*encoded_checkpoint));
  if (!checkpoint || checkpoint->vault_uuid != configuration.vault_uuid) { local_failure(); return nullptr; }
  auto context = std::make_shared<CheckpointContext>();
  auto store = syncer::SyncVaultStore::Create(
      CreateProviderTransport(Provider(profile)->GetWeakPtr(), configuration.provider.id, configuration.vault_uuid, context->active),
      std::make_unique<syncer::LoopbackServerStateCodec>(), base::as_byte_span(*key),
      configuration.vault_uuid, *checkpoint,
      base::BindRepeating(&PersistCheckpoint, profile->GetWeakPtr(), configuration, encryptor, context));
  std::fill(key->begin(), key->end(), '\0');
  if (!store.has_value()) return nullptr;
  return std::make_unique<Backend>(std::move(*store), context,
      base::BindRepeating(&ReportDiagnostics, profile->GetWeakPtr(), configuration, context->active));
}
const char* DiagnosticMessage(prefs::ReconciliationError error) {
  using D = prefs::ReconciliationError;
  switch (error) {
    case D::kAuthenticationRequired: return "The provider requires sign-in. Complete provider authentication, then retry.";
    case D::kQuotaExceeded: return "The provider has reached its storage quota. Free provider storage before retrying.";
    case D::kAccessDenied: return "The provider denied vault access. Check the account and vault permissions.";
    case D::kNetwork:
    case D::kTemporary:
    case D::kConflict: return "The provider is unavailable or changed during reconciliation. Native sync will retry.";
    case D::kCheckpointPersistence: return "This device could not read or save its protected sync state. Sync is paused; use recovery if key access cannot be restored.";
    case D::kIncompleteHistory: return "The provider is missing vault history. Restore the missing objects through the provider; do not overwrite the vault.";
    case D::kAborted: return "Sync was interrupted. Retry when the provider is available.";
    default: return "The vault failed an integrity or compatibility check. Sync is paused. Check the provider and recovery before retrying.";
  }
}
base::DictValue ReadStatus(Profile* profile) {
  base::DictValue status;
  status.Set("configured", IsConfigured(profile));
  auto* sync = IsConfigured(profile) ? SyncServiceFactory::GetForProfile(profile) : nullptr;
  const bool active = sync && IsConfigured(profile) &&
      sync->GetTransportState() == syncer::SyncService::TransportState::ACTIVE;
  status.Set("active", active);
  const auto selected = sync ? sync->GetUserSettings()->GetSelectedTypes() : syncer::UserSelectableTypeSet();
  status.Set("spacesEnabled", selected.Has(syncer::UserSelectableType::kPreferences));
  status.Set("passwordsEnabled", selected.Has(syncer::UserSelectableType::kPasswords));
  status.Set("spacesActive", active && sync->GetActiveDataTypes().Has(syncer::PREFERENCES));
  status.Set("passwordsActive", active && sync->GetActiveDataTypes().Has(syncer::PASSWORDS));
  const bool requested_types_active = active &&
      (!selected.Has(syncer::UserSelectableType::kPreferences) || sync->GetActiveDataTypes().Has(syncer::PREFERENCES)) &&
      (!selected.Has(syncer::UserSelectableType::kPasswords) || sync->GetActiveDataTypes().Has(syncer::PASSWORDS));
  status.Set("initialSyncComplete", requested_types_active && sync->HasCompletedSyncCycle() &&
      sync->GetTypesWithPendingDownloadForInitialSync().empty());
  const auto configuration = profile ? prefs::ReadConfiguration(*profile->GetPrefs()) : std::nullopt;
  if (configuration) {
    status.Set("providerId", configuration->provider.id);
    status.Set("vaultId", configuration->vault_uuid);
  }
  auto diagnostics = profile ? prefs::ReadDiagnostics(*profile->GetPrefs()) : std::nullopt;
  const bool invalid_configuration = profile && profile->GetPrefs()->GetUserPrefValue(prefs::kConfiguration) && !configuration;
  status.Set("invalidConfiguration", invalid_configuration);
  status.Set("hasError", invalid_configuration || (diagnostics && diagnostics->last_error.has_value()));
  if (invalid_configuration) status.Set("errorMessage", "The saved sync configuration is unreadable or uses an unsupported format. Disconnect the saved configuration before recovery; local data and the remote vault are kept.");
  if (!invalid_configuration && diagnostics && diagnostics->last_error) status.Set("errorMessage", DiagnosticMessage(*diagnostics->last_error));
  if (diagnostics) {
    status.Set("lastSuccess", static_cast<double>(diagnostics->last_success.InMillisecondsSinceUnixEpoch()));
  }
  return status;
}
}  // namespace breezer_sync
