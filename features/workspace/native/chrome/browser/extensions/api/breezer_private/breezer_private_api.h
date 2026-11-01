// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_
#define CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_

#include <string>

#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/weak_document_ptr.h"
#include "extensions/browser/extension_function.h"
#include "extensions/browser/extension_function_histogram_value.h"

class BrowserWindowInterface;
class Profile;

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

}  // namespace extensions

#endif  // CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_
