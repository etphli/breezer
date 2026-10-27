// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_UI_VIEWS_FRAME_BREEZER_WORKSPACE_VIEW_H_
#define CHROME_BROWSER_UI_VIEWS_FRAME_BREEZER_WORKSPACE_VIEW_H_

#include <memory>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "chrome/browser/ui/views/extensions/extension_view_views.h"
#include "extensions/browser/extension_host_registry.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_registry_observer.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/views/view.h"

class BrowserWindowInterface;

namespace extensions {
class ExtensionHost;
class ExtensionViewHost;
}  // namespace extensions

// Hosts Breezer's per-window sidebar document (workspace.html) inside the
// vertical tab strip region. The native tab collection stays attached to its
// controllers; the region only hides it while this view is available, and
// shows it again whenever the document cannot run (extension unloaded,
// renderer gone, or the page closed itself). The document is recreated when
// the extension loads again.
class BreezerWorkspaceView final
    : public views::View,
      public ExtensionViewViews::Observer,
      public extensions::ExtensionHostRegistry::Observer,
      public extensions::ExtensionRegistryObserver {
  METADATA_HEADER(BreezerWorkspaceView, views::View)

 public:
  static constexpr int kViewId = 0x42525753;  // "BRWS"

  // Runs whenever is_available() changes after construction.
  using AvailabilityChangedCallback = base::RepeatingCallback<void(bool)>;

  BreezerWorkspaceView(BrowserWindowInterface& browser,
                       AvailabilityChangedCallback availability_changed);
  BreezerWorkspaceView(const BreezerWorkspaceView&) = delete;
  BreezerWorkspaceView& operator=(const BreezerWorkspaceView&) = delete;
  ~BreezerWorkspaceView() override;

  bool is_available() const;
  views::View* GetFocusableView() const;

  // Call before removing this view while code inside the document may still be
  // running (for example a layout change requested by the document). The host
  // is destroyed in a later task; destroying this view afterwards is safe.
  void ReleaseExtensionContentSoon();

 private:
  void CreateExtensionContent();
  // Synchronous teardown: removes the WebView before the host is destroyed.
  void ResetExtensionContent();
  // Detaches the content now and destroys it in a later task. Used when the
  // host itself (or its WebContents) may still be on the call stack.
  void DetachExtensionContentSoon();
  void UpdateAvailability();
  void HandleCloseExtensionHost(extensions::ExtensionHost* host);

  // ExtensionViewViews::Observer:
  void OnViewDestroying() override;

  // extensions::ExtensionHostRegistry::Observer:
  void OnExtensionHostRenderProcessGone(
      content::BrowserContext* browser_context,
      extensions::ExtensionHost* host) override;
  void OnExtensionHostRegistryShutdown(
      extensions::ExtensionHostRegistry* registry) override;

  // extensions::ExtensionRegistryObserver:
  void OnExtensionLoaded(content::BrowserContext* browser_context,
                         const extensions::Extension* extension) override;
  void OnExtensionUnloaded(content::BrowserContext* browser_context,
                           const extensions::Extension* extension,
                           extensions::UnloadedExtensionReason reason) override;
  void OnShutdown(extensions::ExtensionRegistry* registry) override;

  const raw_ref<BrowserWindowInterface> browser_;
  AvailabilityChangedCallback availability_changed_;
  bool was_available_ = false;

  base::ScopedObservation<extensions::ExtensionRegistry,
                          extensions::ExtensionRegistryObserver>
      registry_observation_{this};
  base::ScopedObservation<extensions::ExtensionHostRegistry,
                          extensions::ExtensionHostRegistry::Observer>
      host_registry_observation_{this};
  base::ScopedObservation<ExtensionViewViews, ExtensionViewViews::Observer>
      view_observation_{this};
  std::unique_ptr<extensions::ExtensionViewHost> extension_host_;
  raw_ptr<ExtensionViewViews> extension_view_ = nullptr;

  base::WeakPtrFactory<BreezerWorkspaceView> weak_factory_{this};
};

#endif  // CHROME_BROWSER_UI_VIEWS_FRAME_BREEZER_WORKSPACE_VIEW_H_
