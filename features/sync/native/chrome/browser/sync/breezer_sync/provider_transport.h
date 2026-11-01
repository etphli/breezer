// Copyright 2026 The Breezer Authors
#ifndef CHROME_BROWSER_SYNC_BREEZER_SYNC_PROVIDER_TRANSPORT_H_
#define CHROME_BROWSER_SYNC_BREEZER_SYNC_PROVIDER_TRANSPORT_H_

#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "chrome/browser/extensions/api/sync_vault_provider/sync_vault_provider_service.h"
#include "components/sync/engine/sync_vault/sync_vault_transport.h"

namespace breezer_sync {
// Construct on UI; use on the engine's blocking sequence. The provider sees
// ciphertext and exact revisions only. Never a password, snapshot or vault key.
std::unique_ptr<syncer::SyncVaultTransport> CreateProviderTransport(
    base::WeakPtr<extensions::SyncVaultProviderService> service,
    std::string provider_id,
    std::string vault_uuid);
}  // namespace breezer_sync
#endif
