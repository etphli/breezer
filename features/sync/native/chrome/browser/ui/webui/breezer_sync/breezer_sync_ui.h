// Copyright 2026 The Breezer Authors
#ifndef CHROME_BROWSER_UI_WEBUI_BREEZER_SYNC_BREEZER_SYNC_UI_H_
#define CHROME_BROWSER_UI_WEBUI_BREEZER_SYNC_BREEZER_SYNC_UI_H_
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"
namespace breezer_sync {
class BreezerSyncUI : public content::WebUIController {
 public:
  explicit BreezerSyncUI(content::WebUI* web_ui);
  ~BreezerSyncUI() override;
};
class BreezerSyncUIConfig : public content::DefaultWebUIConfig<BreezerSyncUI> {
 public:
  BreezerSyncUIConfig() : DefaultWebUIConfig("chrome", "breezer-sync") {}
  bool IsWebUIEnabled(content::BrowserContext* context) override;
};
}  // namespace breezer_sync
#endif
