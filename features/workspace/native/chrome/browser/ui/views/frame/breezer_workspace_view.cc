// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/ui/views/frame/breezer_workspace_view.h"

#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/extensions/extension_view_host_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/helium/breezer_workspace_prefs.h"
#include "extensions/browser/extension_host.h"
#include "extensions/browser/unloaded_extension_reason.h"
#include "extensions/common/extension.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/views/layout/fill_layout.h"
#include "url/gurl.h"

BreezerWorkspaceView::BreezerWorkspaceView(
    BrowserWindowInterface& browser,
    AvailabilityChangedCallback availability_changed)
    : browser_(browser),
      availability_changed_(std::move(availability_changed)) {
  SetID(kViewId);
  SetLayoutManager(std::make_unique<views::FillLayout>());

  // Private windows keep the native layout; the extension is not allowed in
  // incognito and the sidebar must not touch the regular profile from there.
  Profile* const profile = browser_->GetProfile();
  if (profile && !profile->IsOffTheRecord()) {
    if (auto* const registry = extensions::ExtensionRegistry::Get(profile)) {
      registry_observation_.Observe(registry);
    }
    if (auto* const host_registry =
            extensions::ExtensionHostRegistry::Get(profile)) {
      host_registry_observation_.Observe(host_registry);
    }
    CreateExtensionContent();
  }
  was_available_ = is_available();
  SetVisible(was_available_);
}

BreezerWorkspaceView::~BreezerWorkspaceView() {
  ResetExtensionContent();
}

bool BreezerWorkspaceView::is_available() const {
  return extension_host_ && extension_view_;
}

views::View* BreezerWorkspaceView::GetFocusableView() const {
  return extension_view_;
}

void BreezerWorkspaceView::ReleaseExtensionContentSoon() {
  DetachExtensionContentSoon();
  UpdateAvailability();
}

void BreezerWorkspaceView::CreateExtensionContent() {
  if (extension_host_ || !registry_observation_.IsObserving() ||
      browser_->IsDeleteScheduled()) {
    return;
  }
  Profile* const profile = browser_->GetProfile();
  const extensions::Extension* const extension =
      extensions::ExtensionRegistry::Get(profile)->enabled_extensions().GetByID(
          breezer_workspace::kExtensionId);
  if (!extension) {
    return;
  }

  // The document reads its window from the URL so it never has to guess which
  // browser hosts it.
  const GURL url = extension->ResolveExtensionURL(base::StrCat(
      {"workspace.html#/sidebar?w=",
       base::NumberToString(
           extensions::ExtensionTabUtil::GetWindowId(&*browser_))}));
  extension_host_ = extensions::ExtensionViewHostFactory::CreateSidePanelHost(
      *extension, url, &*browser_, /*tab_interface=*/nullptr);
  if (!extension_host_) {
    return;
  }

  // window.close() (and other close requests) run this synchronously from
  // inside the host, so the handler must not destroy the host directly.
  extension_host_->SetCloseHandler(
      base::BindOnce(&BreezerWorkspaceView::HandleCloseExtensionHost,
                     weak_factory_.GetWeakPtr()));

  auto extension_view =
      std::make_unique<ExtensionViewViews>(profile, extension_host_.get());
  extension_view->Init();
  extension_view_ = AddChildView(std::move(extension_view));
  view_observation_.Observe(extension_view_);
}

void BreezerWorkspaceView::ResetExtensionContent() {
  view_observation_.Reset();
  if (extension_view_) {
    RemoveChildViewT(std::exchange(extension_view_, nullptr));
  }
  extension_host_.reset();
}

void BreezerWorkspaceView::DetachExtensionContentSoon() {
  view_observation_.Reset();
  std::unique_ptr<ExtensionViewViews> view;
  if (extension_view_) {
    view = RemoveChildViewT(std::exchange(extension_view_, nullptr));
  }
  std::unique_ptr<extensions::ExtensionViewHost> host =
      std::move(extension_host_);
  if (view || host) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](std::unique_ptr<ExtensionViewViews> view,
               std::unique_ptr<extensions::ExtensionViewHost> host) {
              // The WebView must go before the host it displays.
              view.reset();
              host.reset();
            },
            std::move(view), std::move(host)));
  }
}

void BreezerWorkspaceView::UpdateAvailability() {
  const bool available = is_available();
  SetVisible(available);
  if (available == was_available_) {
    return;
  }
  was_available_ = available;
  if (availability_changed_) {
    availability_changed_.Run(available);
  }
}

void BreezerWorkspaceView::HandleCloseExtensionHost(
    extensions::ExtensionHost* host) {
  if (host != extension_host_.get()) {
    return;
  }
  // Show the native tabs again. The document comes back when the extension
  // is loaded again, so a page that closes itself cannot loop.
  DetachExtensionContentSoon();
  UpdateAvailability();
}

void BreezerWorkspaceView::OnViewDestroying() {
  // The WebView is already being destroyed; only release the host.
  view_observation_.Reset();
  extension_view_ = nullptr;
  DetachExtensionContentSoon();
  UpdateAvailability();
}

void BreezerWorkspaceView::OnExtensionHostRenderProcessGone(
    content::BrowserContext* browser_context,
    extensions::ExtensionHost* host) {
  if (!extension_host_ || host != extension_host_.get()) {
    return;
  }
  // The extension service terminates the extension after this; the document is
  // recreated from OnExtensionLoaded once it is reloaded.
  DetachExtensionContentSoon();
  UpdateAvailability();
}

void BreezerWorkspaceView::OnExtensionHostRegistryShutdown(
    extensions::ExtensionHostRegistry* registry) {
  host_registry_observation_.Reset();
}

void BreezerWorkspaceView::OnExtensionLoaded(
    content::BrowserContext* browser_context,
    const extensions::Extension* extension) {
  if (extension->id() != breezer_workspace::kExtensionId) {
    return;
  }
  CreateExtensionContent();
  UpdateAvailability();
}

void BreezerWorkspaceView::OnExtensionUnloaded(
    content::BrowserContext* browser_context,
    const extensions::Extension* extension,
    extensions::UnloadedExtensionReason reason) {
  if (extension->id() != breezer_workspace::kExtensionId) {
    return;
  }
  if (reason == extensions::UnloadedExtensionReason::PROFILE_SHUTDOWN) {
    // The profile is going away; a later task would outlive it.
    ResetExtensionContent();
  } else {
    // Unloading can start from inside the document (for example
    // chrome.runtime.reload()), so destroy the host in a later task. Clearing
    // the members now lets a synchronous reload create fresh content.
    DetachExtensionContentSoon();
  }
  UpdateAvailability();
}

void BreezerWorkspaceView::OnShutdown(extensions::ExtensionRegistry* registry) {
  registry_observation_.Reset();
  ResetExtensionContent();
  UpdateAvailability();
}

BEGIN_METADATA(BreezerWorkspaceView)
END_METADATA
