// Copyright 2026 The Breezer Authors
#include "chrome/browser/extensions/api/breezer_private/breezer_private_api.h"

#include "base/json/json_reader.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/sync/breezer_sync/backend.h"
#include "chrome/browser/sync/breezer_sync/prefs.h"
#include "chrome/browser/sync/private_sync/private_sync_prefs.h"
#include "chrome/browser/sync/sync_service_factory.h"
#include "components/prefs/pref_service.h"
#include "components/sync/base/user_selectable_type.h"
#include "components/sync/service/sync_service.h"
#include "components/sync/service/sync_user_settings.h"

namespace extensions {
namespace {
constexpr size_t kMaximumModelBytes = 1024 * 1024;
base::DictValue ReadWorkspace(Profile* profile) {
  auto configuration = browser_sync::private_sync_prefs::ReadConfiguration(*profile->GetPrefs());
  const bool configured = breezer_sync::IsConfigured(profile);
  auto* service = configured ? SyncServiceFactory::GetForProfile(profile) : nullptr;
  const bool enabled = configured && service && service->GetUserSettings()->GetSelectedTypes().Has(syncer::UserSelectableType::kPreferences);
  const auto health = breezer_sync::ReadStatus(profile);
  return base::DictValue()
      .Set("configured", configured)
      .Set("workspaceEnabled", enabled)
      .Set("nativeError", health.FindBool("hasError").value_or(false))
      .Set("nativeMessage", health.FindString("errorMessage") ? *health.FindString("errorMessage") : std::string())
      .Set("providerId", configuration ? configuration->provider.id : std::string())
      .Set("vaultId", configuration ? configuration->vault_uuid : std::string())
      .Set("model", enabled ? profile->GetPrefs()->GetString(breezer_sync::kWorkspacePref) : std::string());
}
}  // namespace

ExtensionFunction::ResponseAction
BreezerPrivateReadWorkspaceSyncFunction::RunFunction() {
  if (!args().empty()) return RespondNow(Error("readWorkspaceSync does not accept arguments."));
  auto* sync = breezer_sync::IsConfigured(GetProfile()) ? SyncServiceFactory::GetForProfile(GetProfile()) : nullptr;
  if (sync) {
    if (sync->GetTransportState() == syncer::SyncService::TransportState::DISABLED &&
        breezer_sync::GetBackendStatus(GetProfile()) == syncer::CustomSyncBackendStatus::kEnabled) sync->ReconfigureBackend();
    sync->TriggerRefresh(syncer::SyncService::TriggerRefreshSource::kExtensionSyncProvider, sync->GetActiveDataTypes());
  }
  return RespondNow(WithArguments(ReadWorkspace(GetProfile())));
}

ExtensionFunction::ResponseAction
BreezerPrivateExchangeWorkspaceSyncFunction::RunFunction() {
  if (args().size() != 1 || !args()[0].is_dict()) return RespondNow(Error("Invalid workspace sync request."));
  const auto& request = args()[0].GetDict();
  const auto* provider = request.FindString("providerId");
  const auto* vault = request.FindString("vaultId");
  const auto* expected = request.FindString("expectedModel");
  const auto* model = request.FindString("model");
  if (request.size() != 4 || !provider || provider->size() != 32 || !vault || vault->size() != 36 || !expected || !model ||
      expected->size() > kMaximumModelBytes || model->size() > kMaximumModelBytes)
    return RespondNow(Error("Workspace sync data exceeds its bounds."));
  auto parsed = base::JSONReader::ReadDict(*model, base::JSON_PARSE_RFC);
  const auto* records = parsed ? parsed->FindDict("records") : nullptr;
  if (!parsed || parsed->size() != 2 || parsed->FindInt("version") != 1 ||
      !records || records->size() > 12000)
    return RespondNow(Error("Invalid workspace sync model."));
  auto state = ReadWorkspace(GetProfile());
  if (!state.FindBool("configured").value_or(false) ||
      !state.FindBool("workspaceEnabled").value_or(false) ||
      state.FindString("providerId") == nullptr || *state.FindString("providerId") != *provider ||
      state.FindString("vaultId") == nullptr || *state.FindString("vaultId") != *vault)
    return RespondNow(WithArguments(std::move(state)));
  auto* prefs = GetProfile()->GetPrefs();
  const auto* pref = prefs->FindPreference(breezer_sync::kWorkspacePref);
  if (!pref || !pref->IsUserModifiable()) return RespondNow(Error("Workspace sync is controlled by policy."));
  // Fixed preference only. Callers cannot name other preferences, inspect the
  // vault configuration/key/checkpoint, or reach password-manager data.
  if (prefs->GetString(breezer_sync::kWorkspacePref) == *expected)
    prefs->SetString(breezer_sync::kWorkspacePref, *model);
  if (auto* sync = SyncServiceFactory::GetForProfile(GetProfile()))
    sync->TriggerRefresh(syncer::SyncService::TriggerRefreshSource::kExtensionSyncProvider, sync->GetActiveDataTypes());
  return RespondNow(WithArguments(ReadWorkspace(GetProfile())));
}
}  // namespace extensions
