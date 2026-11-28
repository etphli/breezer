// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_
#define CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_

#include <memory>
#include <string>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/process/process_handle.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/common/child_process_id.h"
#include "extensions/browser/extension_function.h"
#include "extensions/browser/extension_function_histogram_value.h"

class BrowserWindowInterface;
class Profile;
class SkBitmap;

namespace memory_instrumentation {
class GlobalMemoryDump;
}

namespace extensions {

class BreezerPrivateFunction : public ExtensionFunction {
 protected:
  BreezerPrivateFunction();
  ~BreezerPrivateFunction() override;

  ResponseAction Run() override;
  virtual ResponseAction RunFunction() = 0;

  Profile* GetProfile() const;
  BrowserWindowInterface* GetCallerBrowser() const;
};

class BreezerPrivateGetAppearanceFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.getAppearance", UNKNOWN)

 private:
  ~BreezerPrivateGetAppearanceFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateSetAppearanceFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.setAppearance", UNKNOWN)

 private:
  ~BreezerPrivateSetAppearanceFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateSetSidebarCollapsedFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.setSidebarCollapsed", UNKNOWN)

 private:
  ~BreezerPrivateSetSidebarCollapsedFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateAuthorizeCurrentPageFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.authorizeCurrentPage", UNKNOWN)

 private:
  ~BreezerPrivateAuthorizeCurrentPageFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateGetResearchTabsFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.getResearchTabs", UNKNOWN)
 private:
  ~BreezerPrivateGetResearchTabsFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateGetBrowserStatsFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.getBrowserStats", UNKNOWN)

 private:
  struct Renderer {
    base::ProcessId pid;
    content::ChildProcessId host_id;
    bool shared = false;
  };

  ~BreezerPrivateGetBrowserStatsFunction() override = default;
  ResponseAction RunFunction() override;
  void OnSystemMemory(base::DictValue system_memory);
  void Finish(std::unique_ptr<memory_instrumentation::GlobalMemoryDump> dump,
              bool sample_complete);

  base::DictValue result_;
  std::vector<Renderer> renderers_;
  base::OneShotTimer timeout_;
  base::WeakPtrFactory<BreezerPrivateGetBrowserStatsFunction> weak_factory_{
      this};
};

class BreezerPrivateReadResearchTabFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.readResearchTab", UNKNOWN)
 private:
  ~BreezerPrivateReadResearchTabFunction() override = default;
  ResponseAction RunFunction() override;
  void OnText(base::Value value);
  void OnTimeout();
  content::WeakDocumentPtr document_;
  int tab_id_ = -1;
  std::string expected_url_;
  base::OneShotTimer timeout_;
};

class BreezerPrivateReadWorkspaceSyncFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.readWorkspaceSync", UNKNOWN)
 private:
  ~BreezerPrivateReadWorkspaceSyncFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateExchangeWorkspaceSyncFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.exchangeWorkspaceSync", UNKNOWN)
 private:
  ~BreezerPrivateExchangeWorkspaceSyncFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateSetPeekSourcesFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.setPeekSources", UNKNOWN)

 private:
  ~BreezerPrivateSetPeekSourcesFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateToggleSplitViewFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.toggleSplitView", UNKNOWN)

 private:
  ~BreezerPrivateToggleSplitViewFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateShowExtensionsMenuFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.showExtensionsMenu", UNKNOWN)

 private:
  ~BreezerPrivateShowExtensionsMenuFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateQueryOmniboxFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.queryOmnibox", UNKNOWN)

 private:
  ~BreezerPrivateQueryOmniboxFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateNextOmniboxResultFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.nextOmniboxResult", UNKNOWN)

 private:
  ~BreezerPrivateNextOmniboxResultFunction() override = default;
  ResponseAction RunFunction() override;
  void OnResult(base::DictValue result);
};

class BreezerPrivateOpenOmniboxFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.openOmnibox", UNKNOWN)

 private:
  ~BreezerPrivateOpenOmniboxFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateIsCurrentPdfFunction final : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.isCurrentPdf", UNKNOWN)

 private:
  ~BreezerPrivateIsCurrentPdfFunction() override = default;
  ResponseAction RunFunction() override;
};

class BreezerPrivateCaptureCurrentPdfContextFunction final
    : public BreezerPrivateFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("breezerPrivate.captureCurrentPdfContext", UNKNOWN)

 private:
  ~BreezerPrivateCaptureCurrentPdfContextFunction() override = default;
  ResponseAction RunFunction() override;
  void OnCopied(int tab_id,
                content::WeakDocumentPtr tab_document,
                content::WeakDocumentPtr pdf_document,
                const SkBitmap& bitmap);
  void OnTimeout();

  base::OneShotTimer timeout_;
  base::WeakPtrFactory<BreezerPrivateCaptureCurrentPdfContextFunction>
      weak_factory_{this};
};

}  // namespace extensions

#endif  // CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_
