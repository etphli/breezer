// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/extensions/api/breezer_private/breezer_private_api.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/extensions/extensions_container.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "url/gurl.h"

namespace extensions {

ExtensionFunction::ResponseAction
BreezerPrivateShowExtensionsMenuFunction::RunFunction() {
  if (!args().empty() || !user_gesture() ||
      source_url().GetPath() != "/workspace.html") {
    return RespondNow(Error("Open extensions from the Breezer sidebar."));
  }
  BrowserWindowInterface* const browser = GetCallerBrowser();
  if (!browser || browser->IsDeleteScheduled() ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL) {
    return RespondNow(Error("The calling browser window is unavailable."));
  }
  // Without its toolbar button the menu has nothing to anchor to. The sidebar
  // opens the extensions page instead.
  ExtensionsContainer* const container = ExtensionsContainer::From(*browser);
  if (!container || !browser->GetProfile()->GetPrefs()->GetBoolean(
                        prefs::kShowExtensionsButton)) {
    return RespondNow(Error("The extensions menu is unavailable."));
  }
  container->ToggleExtensionsMenu();
  return RespondNow(NoArguments());
}

}  // namespace extensions
