// Copyright 2026 The Breezer Authors
#include "chrome/browser/ui/webui/breezer_sync/breezer_sync_ui.h"

#include <algorithm>
#include <optional>
#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/task/thread_pool.h"
#include "base/uuid.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/extensions/api/sync_vault_provider/sync_vault_provider_service.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/sync/breezer_sync/backend.h"
#include "chrome/browser/sync/breezer_sync/prefs.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/web_contents.h"
#include "chrome/browser/sync/breezer_sync/provider_transport.h"
#include "chrome/browser/sync/private_sync/private_sync_repository.h"
#include "chrome/browser/sync/sync_service_factory.h"
#include "chrome/browser/ui/webui/breezer_sync/setup_resources.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "components/sync/base/user_selectable_type.h"
#include "components/sync/engine/cancelation_signal.h"
#include "components/sync/engine/loopback_server/loopback_server_state_delta.h"
#include "components/sync/engine/sync_vault/sync_vault_cryptographer.h"
#include "components/sync/engine/sync_vault/sync_vault_store.h"
#include "components/sync/service/sync_backend_type.h"
#include "components/sync/service/sync_service.h"
#include "components/sync/service/sync_user_settings.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "crypto/random.h"
#include "extensions/common/extension.h"
#include "extensions/browser/event_router.h"
#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"

namespace breezer_sync {
namespace {
using Service = extensions::SyncVaultProviderService;
using Repository = browser_sync::private_sync::Repository;
namespace provider_api = extensions::api::sync_vault_provider;
namespace prefs = browser_sync::private_sync_prefs;

struct SetupResult {
  std::optional<prefs::Configuration> configuration;
  std::string recovery_key;
  std::string error;
};

// Runs entirely outside UI. The only output is OS-protected local key material,
// the authenticated checkpoint, and a new-vault recovery key for native UI.
SetupResult PrepareVault(std::unique_ptr<syncer::SyncVaultTransport> transport,
                         std::shared_ptr<syncer::CancelationSignal> cancel,
                         scoped_refptr<os_crypt_async::Encryptor> encryptor,
                         std::string provider, std::string vault,
                         std::vector<uint8_t> key, bool create) {
  SetupResult result;
  auto store = syncer::SyncVaultStore::Create(
      std::move(transport), std::make_unique<syncer::LoopbackServerStateCodec>(),
      key, vault, std::nullopt,
      base::BindRepeating([](const syncer::SyncVaultCheckpoint&) { return true; }));
  if (!store.has_value()) result.error = "Could not prepare this encrypted vault.";
  if (store.has_value()) {
    (*store)->SetCancelationSignal(cancel.get());
    auto read = create ? (*store)->InitializeEmptyVaultAndReadState() : (*store)->ReadState();
    if (!read) {
      switch (read.error()) {
        case syncer::SyncVaultStoreError::kAuthenticationFailed:
        case syncer::SyncVaultStoreError::kInvalidVaultKey:
          result.error = "The vault could not be authenticated. Check the provider and recovery key. No existing vault was overwritten.";
          break;
        default:
          result.error = "Could not authenticate and read the complete vault. Check the provider connection. No local data was replaced.";
      }
    } else {
      auto checkpoint = syncer::SerializeSyncVaultCheckpoint((*store)->checkpoint());
      auto protected_key = encryptor->EncryptString(std::string(key.begin(), key.end()));
      auto protected_checkpoint = checkpoint ? encryptor->EncryptString(std::string(checkpoint->begin(), checkpoint->end())) : std::nullopt;
      if (!protected_key || !protected_checkpoint) {
        result.error = "This device could not protect the sync key. Sync remains disconnected.";
      } else {
        prefs::Configuration configuration;
        configuration.provider.id = provider;
        configuration.vault_uuid = vault;
        configuration.encrypted_vault_key = std::move(*protected_key);
        configuration.encrypted_checkpoint = std::move(*protected_checkpoint);
        configuration.key_mode = prefs::KeyMode::kRecoveryKey;
        result.configuration = std::move(configuration);
        if (create) result.recovery_key = base::Base64Encode(key);
      }
    }
  }
  std::fill(key.begin(), key.end(), 0);
  return result;
}

void WakeWorkspace(Profile* profile) {
  if (!profile) return;
  if (auto* router = extensions::EventRouter::Get(profile)) {
    router->DispatchEventToExtension(breezer_workspace::kExtensionId,
        std::make_unique<extensions::Event>(extensions::events::UNKNOWN,
            "breezerPrivate.onSyncStateChanged", base::ListValue()));
  }
}

class Handler final : public content::WebUIMessageHandler, public Service::Observer {
 public:
  explicit Handler(Profile* profile) : profile_(profile->GetWeakPtr()) {
    if (auto* broker = service()) provider_observation_.Observe(broker);
  }
  ~Handler() override { Abort(); }
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback("breezerSync", base::BindRepeating(&Handler::Handle, base::Unretained(this)));
  }
  void OnJavascriptDisallowed() override { Abort(); }
  void OnSyncVaultProviderConfigurationCompleted() override {
    if (!waiting_for_provider_ || active_request_.empty()) return;
    ProviderReady(active_request_, provider_);
  }
  void OnSyncVaultProviderConfigurationFailed(const Service::ProviderFailure&) override {
    if (!waiting_for_provider_ || active_request_.empty()) return;
    waiting_for_provider_ = false;
    configuration_session_.reset();
    Error(active_request_, "Provider setup failed. Complete provider sign-in and retry.");
  }
  void OnSyncVaultProviderConfigurationStateChanged(provider_api::ProviderConfigurationState state) override {
    if (waiting_for_provider_ && !active_request_.empty()) Progress(active_request_, state);
  }
 private:
  Service* service() { return profile_ ? extensions::SyncVaultProviderServiceFactory::GetForBrowserContext(profile_.get()) : nullptr; }
  void Reply(const std::string& id, base::DictValue value) {
    if (IsJavascriptAllowed()) web_ui()->CallJavascriptFunctionUnsafe("breezerSyncReply", base::Value(id), base::Value(std::move(value)));
  }
  void Error(std::string id, std::string message) {
    if (active_request_.empty() || active_request_ == id) { busy_ = false; active_request_.clear(); }
    Reply(id, base::DictValue().Set("error", std::move(message)));
  }
  base::DictValue Status() {
    auto status = ReadStatus(profile_.get());
    base::ListValue providers;
    if (auto* broker = service()) for (const auto* provider : broker->GetAvailableProviders()) {
      providers.Append(base::DictValue().Set("id", provider->id()).Set("name", provider->name()));
      if (status.FindString("providerId") && *status.FindString("providerId") == provider->id()) status.Set("providerName", provider->name());
    }
    status.Set("providers", std::move(providers));
    return base::DictValue().Set("status", std::move(status));
  }
  void Notify() { WakeWorkspace(profile_.get()); }
  void Disconnected(std::string id) {
    busy_ = false; active_request_.clear(); Notify(); Reply(id, Status());
  }
  void Abort() {
    weak_.InvalidateWeakPtrs();
    if (cancel_) cancel_->Signal();
    waiting_for_provider_ = false;
    cancel_.reset(); configuration_session_.reset(); pending_.reset();
    provider_ready_ = false;
    busy_ = false; active_request_.clear();
  }
  bool StillSelected(const std::string& provider) {
    return service() && service()->selected_provider_id() == provider;
  }
  void Handle(const base::ListValue& args) {
    if (args.size() != 3 || !args[0].is_string() || args[0].GetString().size() > 64 || !args[1].is_string() || !args[2].is_dict()) return;
    AllowJavascript();
    const auto id = args[0].GetString();
    const auto action = args[1].GetString();
    const auto& data = args[2].GetDict();
    if (!profile_ || profile_->IsOffTheRecord()) { Error(id, "Sync is unavailable in this profile."); return; }
    if (action == "cancel") {
      if (!active_request_.empty()) Reply(active_request_, IsConfigured(profile_.get()) ? Status() : base::DictValue().Set("error", "Setup cancelled. Local data is preserved."));
      Abort(); Reply(id, Status()); return;
    }
    if (action == "status") { Reply(id, Status()); return; }
    if (busy_) { Error(id, "Another sync operation is in progress."); return; }
    if (action != "disconnect" && profile_->GetPrefs()->GetUserPrefValue(prefs::kConfiguration) &&
        !prefs::ReadConfiguration(*profile_->GetPrefs())) { Error(id, "Disconnect the unreadable saved sync configuration before starting recovery. Local data is preserved."); return; }
    auto* sync = SyncServiceFactory::GetForProfile(profile_.get());
    if (!sync || sync->GetSyncBackendType() == syncer::SyncBackendType::kLocal) { Error(id, "This profile's local roaming sync backend cannot be changed here."); return; }
    if (action == "disconnect") {
      Abort();
      auto* repository = Repository::Get(profile_.get());
      if (repository && repository->configuration()) repository->ClearConfiguration(*repository->configuration());
      else { profile_->GetPrefs()->ClearPref(prefs::kConfiguration); if (repository) repository->ClearDiagnostics(); }
      profile_->GetPrefs()->ClearPref(kWorkspacePref);
      sync->ReconfigureBackend();
      if (service()) service()->ClearSelectedProvider();
      busy_ = true; active_request_ = id;
      if (repository) repository->Flush(base::BindOnce(&Handler::Disconnected, weak_.GetWeakPtr(), id));
      else Disconnected(id);
      return;
    }
    if (action == "retry") {
      if (auto* repository = Repository::Get(profile_.get())) repository->ClearDiagnostics();
      sync->ReconfigureBackend(); Notify(); Reply(id, Status()); return;
    }
    if (IsConfigured(profile_.get())) { Error(id, "This profile is already connected. Disconnect before changing vaults."); return; }
    if (action == "confirm") {
      if (!pending_ || !data.FindBool("saved").value_or(false)) { Error(id, "Save your recovery key before connecting."); return; }
      Install(id); return;
    }
    if (action == "provider") {
      const auto* provider = data.FindString("providerId");
      if (!provider || !service() || !service()->SelectProvider(*provider)) { Error(id, "The selected sync provider is unavailable."); return; }
      pending_.reset(); provider_ready_ = false; provider_ = *provider; busy_ = true; active_request_ = id;
      configuration_session_ = service()->Configure(base::BindOnce(&Handler::Configured, weak_.GetWeakPtr(), id, provider_));
      return;
    }
    if (action != "create" && action != "join") { Error(id, "Unknown sync action."); return; }
    if (!StillSelected(provider_) || !provider_ready_) { Error(id, "Choose and configure a provider first."); return; }
    spaces_ = data.FindBool("spaces").value_or(false);
    passwords_ = data.FindBool("passwords").value_or(false);
    if (!spaces_ && !passwords_) { Error(id, "Select saved spaces or passwords to sync."); return; }
    busy_ = true; active_request_ = id;
    const bool create = action == "create";
    std::string vault;
    std::vector<uint8_t> key(syncer::SyncVaultCryptographer::kVaultKeySize);
    if (create) {
      const auto* name = data.FindString("displayName");
      if (!name || name->empty() || name->size() > 256) { Error(id, "Enter a vault name of up to 256 bytes."); return; }
      vault = base::Uuid::GenerateRandomV4().AsLowercaseString();
      crypto::RandBytes(key);
      service()->CreateVault(vault, *name, base::BindOnce(&Handler::Created, weak_.GetWeakPtr(), id, provider_, vault, std::move(key)));
    } else {
      const auto* selected = data.FindString("vaultId");
      const auto* recovery = data.FindString("recoveryKey");
      auto decoded = recovery && recovery->size() <= 128 ? base::Base64Decode(*recovery) : std::nullopt;
      if (!selected || !base::Uuid::ParseLowercase(*selected).is_valid() || !decoded || decoded->size() != key.size()) { Error(id, "Enter a valid vault and recovery key."); return; }
      Protect(id, provider_, *selected, std::move(*decoded), false);
    }
  }
  void Progress(const std::string& id, provider_api::ProviderConfigurationState state) {
    Reply(id, base::DictValue().Set("progress", state == provider_api::ProviderConfigurationState::kPendingUserAction
        ? "Waiting for provider sign-in. Complete the provider's sign-in window, or cancel setup."
        : "The provider is configuring sync. You can cancel setup."));
  }
  void Configured(std::string id, std::string provider, Service::Response result) {
    if (!result || !StillSelected(provider)) {
      waiting_for_provider_ = false;
      configuration_session_.reset();
      Error(id, "Could not configure the provider. Complete provider sign-in and retry.");
      return;
    }
    if (result->success->configuration_state == provider_api::ProviderConfigurationState::kReady) {
      ProviderReady(id, provider);
    } else {
      waiting_for_provider_ = true;
      Progress(id, result->success->configuration_state);
    }
  }
  void ProviderReady(std::string id, std::string provider) {
    waiting_for_provider_ = false;
    configuration_session_.reset();
    if (!StillSelected(provider)) { Error(id, "The sync provider changed. Restart setup."); return; }
    provider_ready_ = true;
    service()->ListVaults(base::BindOnce(&Handler::Listed, weak_.GetWeakPtr(), id, provider));
  }
  void Listed(std::string id, std::string provider, Service::Response result) {
    if (!result || !StillSelected(provider) || !result->success->vaults) { Error(id, "Could not list vaults from this provider."); return; }
    base::ListValue vaults;
    for (const auto& vault : *result->success->vaults) vaults.Append(base::DictValue().Set("vaultUuid", vault.vault_uuid).Set("displayName", vault.display_name));
    busy_ = false; active_request_.clear(); Reply(id, base::DictValue().Set("vaults", std::move(vaults)));
  }
  void Created(std::string id, std::string provider, std::string vault, std::vector<uint8_t> key, Service::Response result) {
    if (!result || !StillSelected(provider)) { std::fill(key.begin(), key.end(), 0); Error(id, "Could not create the vault. Retry after checking the provider."); return; }
    Protect(std::move(id), std::move(provider), std::move(vault), std::move(key), true);
  }
  void Protect(std::string id, std::string provider, std::string vault, std::vector<uint8_t> key, bool create) {
    g_browser_process->os_crypt_async()->GetInstance(base::BindOnce(&Handler::Encrypted, weak_.GetWeakPtr(), id, provider, vault, std::move(key), create));
  }
  void Encrypted(std::string id, std::string provider, std::string vault, std::vector<uint8_t> key, bool create, scoped_refptr<os_crypt_async::Encryptor> encryptor) {
    if (!encryptor || !encryptor->IsEncryptionAvailable() || !StillSelected(provider)) { std::fill(key.begin(), key.end(), 0); Error(id, "This device cannot protect a sync key. Sync remains disconnected."); return; }
    cancel_ = std::make_shared<syncer::CancelationSignal>();
    base::ThreadPool::PostTaskAndReplyWithResult(FROM_HERE, {base::MayBlock(), base::WithBaseSyncPrimitives(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&PrepareVault, CreateProviderTransport(service()->GetWeakPtr(), provider, vault), cancel_, encryptor, provider, vault, std::move(key), create),
        base::BindOnce(&Handler::Prepared, weak_.GetWeakPtr(), id, provider, create));
  }
  void Prepared(std::string id, std::string provider, bool create, SetupResult result) {
    cancel_.reset();
    if (!StillSelected(provider) || IsConfigured(profile_.get())) { Error(id, "Sync configuration changed. Reopen setup."); return; }
    if (!result.configuration) { Error(id, std::move(result.error)); return; }
    pending_ = std::move(result.configuration);
    if (!create) { Install(id); return; }
    busy_ = false; active_request_.clear(); Reply(id, base::DictValue().Set("recoveryKey", result.recovery_key));
    std::fill(result.recovery_key.begin(), result.recovery_key.end(), '\0');
  }
  void Install(const std::string& id) {
    if (!pending_ || !StillSelected(pending_->provider.id)) { Error(id, "The sync provider changed. Restart setup."); return; }
    auto* repository = Repository::Get(profile_.get());
    auto* sync = SyncServiceFactory::GetForProfile(profile_.get());
    if (!repository || !sync) { Error(id, "Native sync is unavailable."); return; }
    syncer::UserSelectableTypeSet types;
    if (spaces_) types.Put(syncer::UserSelectableType::kPreferences);
    if (passwords_) types.Put(syncer::UserSelectableType::kPasswords);
    auto setup_handle = sync->GetSetupInProgressHandle();
    profile_->GetPrefs()->ClearPref(kWorkspacePref);
    repository->InstallConfiguration(std::move(*pending_)); pending_.reset();
    sync->ReconfigureBackend();
    sync->GetUserSettings()->SetSelectedTypes(false, types);
    sync->GetUserSettings()->SetInitialSyncFeatureSetupComplete();
    busy_ = true; active_request_ = id;
    // The durable-write callback owns the hold, rather than this page. Closing
    // setup cannot start the engine before its protected key has been flushed.
    repository->Flush(base::BindOnce(
        [](base::WeakPtr<Profile> profile, base::WeakPtr<Handler> handler,
           std::unique_ptr<syncer::SyncSetupInProgressHandle> hold, std::string id) {
          hold.reset();
          WakeWorkspace(profile.get());
          if (handler) handler->Installed(std::move(id));
        }, profile_, weak_.GetWeakPtr(), std::move(setup_handle), id));
  }
  void Installed(std::string id) {
    if (!profile_) { Error(id, "This profile is no longer available."); return; }
    busy_ = false; active_request_.clear(); Notify(); Reply(id, Status());
  }
  const base::WeakPtr<Profile> profile_;
  bool busy_ = false;
  bool provider_ready_ = false;
  bool waiting_for_provider_ = false;
  bool spaces_ = true;
  bool passwords_ = true;
  std::string active_request_;
  std::string provider_;
  std::optional<prefs::Configuration> pending_;
  std::shared_ptr<syncer::CancelationSignal> cancel_;
  std::unique_ptr<Service::ConfigurationSession> configuration_session_;
  base::ScopedObservation<Service, Service::Observer> provider_observation_{this};
  base::WeakPtrFactory<Handler> weak_{this};
};
}  // namespace

bool BreezerSyncUIConfig::IsWebUIEnabled(content::BrowserContext* context) {
  auto* profile = Profile::FromBrowserContext(context);
  return !profile->IsOffTheRecord() && !profile->IsGuestSession();
}
BreezerSyncUI::BreezerSyncUI(content::WebUI* web_ui) : WebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(web_ui->GetWebContents()->GetBrowserContext(), "breezer-sync");
  source->SetRequestFilter(base::BindRepeating([](const std::string&) { return true; }), base::BindRepeating([](const std::string& path, content::WebUIDataSource::GotDataCallback callback) {
    std::string_view data = path == "setup.js" ? kSetupScript : path == "setup.css" ? kSetupStyle : path.empty() || path == "index.html" ? kSetupHtml : std::string_view();
    std::move(callback).Run(base::MakeRefCounted<base::RefCountedString>(std::string(data)));
  }));
  web_ui->AddMessageHandler(std::make_unique<Handler>(Profile::FromWebUI(web_ui)));
}
BreezerSyncUI::~BreezerSyncUI() = default;
}  // namespace breezer_sync
