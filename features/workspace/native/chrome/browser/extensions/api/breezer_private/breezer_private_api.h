// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#ifndef CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_
#define CHROME_BROWSER_EXTENSIONS_API_BREEZER_PRIVATE_BREEZER_PRIVATE_API_H_

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
