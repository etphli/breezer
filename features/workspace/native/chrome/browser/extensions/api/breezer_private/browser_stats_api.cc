// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/extensions/api/breezer_private/breezer_private_api.h"

#include <algorithm>
#include <map>
#include <set>
#include <string_view>
#include <utility>

#include "base/byte_size.h"
#include "base/functional/bind.h"
#include "base/functional/function_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/process/process.h"
#include "base/process/process_metrics.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/extensions/browser_extension_window_controller.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "services/resource_coordinator/public/cpp/memory_instrumentation/memory_instrumentation.h"

namespace extensions {
namespace {

constexpr int kMaxTabRows = 200;
constexpr size_t kMaxRendererRows = 256;
constexpr size_t kMaxRenderersPerTab = 8;
// Allow enough input for the extension to mask secrets before clipping titles
// to the smaller provider-facing limit.
constexpr size_t kMaxTitleInputLength = 512;

base::DictValue ReadSystemMemory() {
  base::DictValue memory;
  const auto total = base::SysInfo::AmountOfTotalPhysicalMemory();
  if (!total.is_zero()) {
    memory.Set("totalBytes", total.InBytesF());
  }
  base::SystemMemoryInfo system;
  if (base::GetSystemMemoryInfo(&system)) {
    memory.Set("availableBytes",
               system.GetAvailablePhysicalMemory().InBytesF());
  }
  return memory;
}

void ForEachLiveRenderer(
    content::WebContents* contents,
    base::FunctionRef<void(content::RenderProcessHost*)> on_renderer) {
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        auto* host = frame->GetProcess();
        if (frame->IsRenderFrameLive() && host->GetProcess().IsValid() &&
            host->GetBrowserContext() == contents->GetBrowserContext()) {
          on_renderer(host);
        }
      });
}

}  // namespace

ExtensionFunction::ResponseAction
BreezerPrivateGetBrowserStatsFunction::RunFunction() {
  if (args().size() != 1 || !args()[0].is_int() || args()[0].GetInt() < 0) {
    return RespondNow(Error("A Breezer window ID is required."));
  }
  Profile* const profile = GetProfile();
  if (!profile->IsRegularProfile()) {
    return RespondNow(Error("Browser statistics require a regular profile."));
  }

  const int window_id = args()[0].GetInt();
  auto* const browsers = GlobalBrowserCollection::GetInstance();
  BrowserExtensionWindowController* target = nullptr;
  std::vector<BrowserExtensionWindowController*> profile_windows;
  int total_tab_count = 0;
  browsers->ForEach([&](BrowserWindowInterface* browser) {
    if (browser->GetProfile() != profile || !browser->GetWindow()) {
      return true;
    }
    auto* window = BrowserExtensionWindowController::From(browser);
    if (!window || !window->IsVisibleToTabsAPIForExtension(
                       extension(), /*allow_dev_tools_windows=*/false)) {
      return true;
    }
    total_tab_count += window->GetTabCount();
    profile_windows.push_back(window);
    if (window->GetWindowId() == window_id) {
      target = window;
    }
    return true;
  });

  base::ListValue tabs;
  std::map<base::ProcessId, int> renderer_ids;
  std::vector<content::WebContents*> first_tab_for_renderer;
  bool details_truncated = false;
  if (target) {
    const int window_tab_count = target->GetTabCount();
    result_.Set("windowTabCount", window_tab_count);
    const int detail_tab_count = std::min(window_tab_count, kMaxTabRows);
    details_truncated = detail_tab_count < window_tab_count;
    for (int i = 0; i < detail_tab_count; ++i) {
      auto* contents = target->GetWebContentsAt(i);
      base::ListValue tab_renderer_ids;
      std::set<base::ProcessId> seen_in_tab;
      bool renderer_details_truncated = false;
      ForEachLiveRenderer(contents, [&](content::RenderProcessHost* host) {
        const base::ProcessId pid = host->GetProcess().Pid();
        if (seen_in_tab.contains(pid)) {
          return;
        }
        if (tab_renderer_ids.size() >= kMaxRenderersPerTab ||
            (renderer_ids.size() >= kMaxRendererRows &&
             !renderer_ids.contains(pid))) {
          renderer_details_truncated = true;
          return;
        }
        seen_in_tab.insert(pid);
        const auto [it, inserted] =
            renderer_ids.try_emplace(pid, renderers_.size());
        if (inserted) {
          renderers_.push_back({pid, host->GetID()});
          first_tab_for_renderer.push_back(contents);
        }
        tab_renderer_ids.Append(it->second);
      });

      // GetTitleForDisplay can substitute a URL when the page has no title.
      const auto* entry = contents->GetController().GetLastCommittedEntry();
      const std::u16string_view title =
          entry ? std::u16string_view(entry->GetTitle())
                : std::u16string_view();
      size_t title_length = std::min(title.size(), kMaxTitleInputLength);
      // Do not cut between the halves of a surrogate pair, which would turn
      // the last character into U+FFFD.
      if (title_length < title.size() && title_length > 0 &&
          (title[title_length - 1] & 0xFC00) == 0xD800) {
        --title_length;
      }
      base::DictValue tab;
      tab.Set("tabId", ExtensionTabUtil::GetTabId(contents));
      tab.Set("title", base::UTF16ToUTF8(title.substr(0, title_length)));
      tab.Set("rendererProcessIds", std::move(tab_renderer_ids));
      if (renderer_details_truncated) {
        tab.Set("rendererDetailsTruncated", true);
      }
      details_truncated |=
          renderer_details_truncated || title.size() > kMaxTitleInputLength;
      tabs.Append(std::move(tab));
    }
  }
  if (!renderer_ids.empty()) {
    for (auto* window : profile_windows) {
      for (int i = 0; i < window->GetTabCount(); ++i) {
        auto* contents = window->GetWebContentsAt(i);
        ForEachLiveRenderer(contents, [&](content::RenderProcessHost* host) {
          auto it = renderer_ids.find(host->GetProcess().Pid());
          if (it != renderer_ids.end() &&
              first_tab_for_renderer[it->second] != contents) {
            renderers_[it->second].shared = true;
          }
        });
      }
    }
  }
  result_.Set("totalTabCount", total_tab_count);
  result_.Set("tabs", std::move(tabs));
  result_.Set("detailsTruncated", details_truncated);
  result_.Set("systemMemory", base::DictValue());

  timeout_.Start(FROM_HERE, base::Seconds(3),
                 base::BindOnce(&BreezerPrivateGetBrowserStatsFunction::Finish,
                                base::RetainedRef(this), nullptr, false));
  if (!base::ThreadPool::PostTaskAndReplyWithResult(
          FROM_HERE, {base::MayBlock()}, base::BindOnce(&ReadSystemMemory),
          base::BindOnce(&BreezerPrivateGetBrowserStatsFunction::OnSystemMemory,
                         weak_factory_.GetWeakPtr()))) {
    OnSystemMemory(base::DictValue());
  }
  return did_respond() ? AlreadyResponded() : RespondLater();
}

void BreezerPrivateGetBrowserStatsFunction::OnSystemMemory(
    base::DictValue system_memory) {
  result_.Set("systemMemory", std::move(system_memory));
  auto* instrumentation =
      memory_instrumentation::MemoryInstrumentation::GetInstance();
  if (!instrumentation) {
    Finish(nullptr, false);
    return;
  }
  // Use the same private footprint dump as Task Manager's memory column.
  instrumentation->RequestPrivateMemoryFootprint(
      base::kNullProcessId,
      base::BindOnce(
          [](base::WeakPtr<BreezerPrivateGetBrowserStatsFunction> self,
             memory_instrumentation::mojom::RequestOutcome outcome,
             std::unique_ptr<memory_instrumentation::GlobalMemoryDump> dump) {
            if (self) {
              self->Finish(
                  std::move(dump),
                  outcome ==
                      memory_instrumentation::mojom::RequestOutcome::kSuccess);
            }
          },
          weak_factory_.GetWeakPtr()));
}

void BreezerPrivateGetBrowserStatsFunction::Finish(
    std::unique_ptr<memory_instrumentation::GlobalMemoryDump> dump,
    bool sample_complete) {
  scoped_refptr<BreezerPrivateGetBrowserStatsFunction> keep_alive(this);
  weak_factory_.InvalidateWeakPtrs();
  timeout_.Stop();

  std::map<base::ProcessId, double> footprints;
  double total_bytes = 0;
  if (dump) {
    for (const auto& process : dump->process_dumps()) {
      const double bytes =
          base::KiB(process.os_dump().private_footprint_kb).InBytesF();
      if (footprints.try_emplace(process.pid(), bytes).second) {
        total_bytes += bytes;
      }
    }
  }
  base::DictValue browser_memory;
  if (!footprints.empty()) {
    browser_memory.Set("footprintBytes", total_bytes);
  }
  const auto browser = footprints.find(base::GetCurrentProcId());
  if (browser != footprints.end()) {
    browser_memory.Set("browserProcessBytes", browser->second);
  }
  browser_memory.Set("measuredProcessCount",
                     static_cast<int>(footprints.size()));
  browser_memory.Set("sampleComplete",
                     sample_complete && browser != footprints.end());
  result_.Set("browserMemory", std::move(browser_memory));

  base::ListValue renderers;
  for (size_t i = 0; i < renderers_.size(); ++i) {
    const auto& renderer = renderers_[i];
    base::DictValue process;
    process.Set("id", static_cast<int>(i));
    process.Set("shared", renderer.shared);
    auto* host = content::RenderProcessHost::FromID(renderer.host_id);
    auto footprint = footprints.find(renderer.pid);
    if (footprint != footprints.end() && host && host->IsReady() &&
        host->GetProcess().Pid() == renderer.pid) {
      process.Set("footprintBytes", footprint->second);
    }
    renderers.Append(std::move(process));
  }
  result_.Set("rendererProcesses", std::move(renderers));
  Respond(WithArguments(std::move(result_)));
}

}  // namespace extensions
