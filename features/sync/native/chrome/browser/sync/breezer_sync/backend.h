// Copyright 2026 The Breezer Authors
#ifndef CHROME_BROWSER_SYNC_BREEZER_SYNC_BACKEND_H_
#define CHROME_BROWSER_SYNC_BREEZER_SYNC_BACKEND_H_
#include <memory>
#include "base/memory/scoped_refptr.h"
#include "base/values.h"
#include "components/sync/service/sync_client.h"
class Profile;
namespace os_crypt_async { class Encryptor; }
namespace syncer { class CustomSyncBackend; }
namespace breezer_sync {
inline constexpr char kWorkspacePref[] = "breezer.sync.workspace";
bool IsConfigured(Profile* profile);
syncer::CustomSyncBackendStatus GetBackendStatus(Profile* profile);
std::string GetBackendNamespace(Profile* profile);
std::unique_ptr<syncer::CustomSyncBackend> CreateBackend(
    Profile* profile, scoped_refptr<os_crypt_async::Encryptor> encryptor);
base::DictValue ReadStatus(Profile* profile);
}  // namespace breezer_sync
#endif
