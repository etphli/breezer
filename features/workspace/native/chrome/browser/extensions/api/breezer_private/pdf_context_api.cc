// Copyright 2026 The Breezer Authors
// This file is governed by the same license as the Breezer project.

#include "chrome/browser/extensions/api/breezer_private/breezer_private_api.h"

#include <utility>

#include "base/values.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "content/public/browser/web_contents.h"
#include "pdf/buildflags.h"
#include "url/gurl.h"

#if BUILDFLAG(ENABLE_PDF)
#include <algorithm>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/scoped_refptr.h"
#include "base/task/bind_post_task.h"
#include "base/time/time.h"
#include "components/pdf/browser/pdf_document_helper.h"
#include "components/pdf/browser/pdf_frame_util.h"
#include "components/pdf/common/constants.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/visibility.h"
#include "pdf/pdf_features.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/jpeg_codec.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/geometry/size_conversions.h"
#endif  // BUILDFLAG(ENABLE_PDF)

namespace extensions {
namespace {

// IDs supplied by the panel only identify the active tab of its own window.
content::WebContents* GetActiveTab(BrowserWindowInterface* browser, int tab_id) {
  if (!browser || browser->IsDeleteScheduled() ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL) {
    return nullptr;
  }
  content::WebContents* const active =
      browser->GetTabStripModel()->GetActiveWebContents();
  return active && ExtensionTabUtil::GetTabId(active) == tab_id ? active
                                                               : nullptr;
}

bool HasPanelTabArgument(const GURL& source, const base::ListValue& args) {
  return source.GetPath() == "/panel.html" && args.size() == 1 &&
         args[0].is_int() && args[0].GetInt() >= 0;
}

#if BUILDFLAG(ENABLE_PDF)

constexpr int kMaxPdfImageEdge = 1400;
constexpr size_t kMaxPdfImageBytes = 2 * 1024 * 1024;
constexpr base::TimeDelta kCopyTimeout = base::Seconds(3);

content::RenderFrameHost* GetPdfFrame(content::WebContents& contents) {
  if (!chrome_pdf::features::IsOopifPdfEnabled()) {
    return nullptr;
  }
  // These helpers require the committed PDF MIME type, built-in viewer origin
  // and a PDF process. An embedded PDF in an HTML tab cannot match.
  auto* const extension_host =
      pdf_frame_util::FindFullPagePdfExtensionHost(&contents);
  return extension_host ? pdf_frame_util::FindPdfChildFrame(extension_host)
                        : nullptr;
}

bool IsVisible(content::WebContents& contents) {
  return contents.GetVisibility() == content::Visibility::VISIBLE;
}

#endif  // BUILDFLAG(ENABLE_PDF)

}  // namespace

ExtensionFunction::ResponseAction
BreezerPrivateIsCurrentPdfFunction::RunFunction() {
  if (!HasPanelTabArgument(source_url(), args())) {
    return RespondNow(Error("Check the current tab from the Breezer AI panel."));
  }
  content::WebContents* const contents =
      GetActiveTab(GetCallerBrowser(), args()[0].GetInt());
  if (!contents) {
    return RespondNow(WithArguments(false));
  }
#if BUILDFLAG(ENABLE_PDF)
  return RespondNow(WithArguments(GetPdfFrame(*contents) != nullptr));
#else
  return RespondNow(WithArguments(false));
#endif
}

ExtensionFunction::ResponseAction
BreezerPrivateCaptureCurrentPdfContextFunction::RunFunction() {
  if (!user_gesture() || !HasPanelTabArgument(source_url(), args())) {
    return RespondNow(Error("Send from Breezer AI to share the current PDF."));
  }
  const int tab_id = args()[0].GetInt();
  content::WebContents* const contents = GetActiveTab(GetCallerBrowser(), tab_id);
  if (!contents) {
    return RespondNow(Error("The current tab changed. Try again."));
  }

#if BUILDFLAG(ENABLE_PDF)
  if (contents->GetContentsMimeType() == pdf::kPDFMimeType) {
    content::RenderFrameHost* const pdf_frame = GetPdfFrame(*contents);
    pdf::PDFDocumentHelper* const helper =
        pdf::PDFDocumentHelper::MaybeGetForFullPagePdf(*contents);
    if (!pdf_frame || !pdf_frame->IsRenderFrameLive() || !helper ||
        !helper->IsDocumentLoadComplete() || !IsVisible(*contents)) {
      return RespondNow(
          Error("Open the PDF in the built-in viewer and wait for it to load."));
    }

    content::RenderWidgetHostView* const view = pdf_frame->GetView();
    content::RenderWidgetHostView* const tab_view =
        contents->GetRenderWidgetHostView();
    if (!view || !tab_view || !view->IsSurfaceAvailableForCopy()) {
      return RespondNow(Error("The PDF viewport is unavailable. Try again."));
    }

    // Only the PDF renderer's viewport intersects the tab. Copying this child
    // surface excludes the built-in viewer's toolbar, filenames and prompts.
    const gfx::Rect view_bounds = view->GetViewBounds();
    gfx::Rect source_rect =
        gfx::IntersectRects(view_bounds, tab_view->GetViewBounds());
    if (source_rect.IsEmpty()) {
      return RespondNow(Error("The PDF viewport is unavailable. Try again."));
    }
    source_rect.Offset(-view_bounds.x(), -view_bounds.y());
    const int edge = std::max(source_rect.width(), source_rect.height());
    const float scale = std::min(1.f, static_cast<float>(kMaxPdfImageEdge) / edge);
    gfx::Size output = gfx::ScaleToFlooredSize(source_rect.size(), scale);
    output.SetToMax(gfx::Size(1, 1));

    // Keep the extension request alive until the copy responds or times out.
    timeout_.Start(
        FROM_HERE, kCopyTimeout + base::Seconds(1),
        base::BindOnce(
            &BreezerPrivateCaptureCurrentPdfContextFunction::OnTimeout,
            base::RetainedRef(this)));
    view->CopyFromSurface(
        source_rect, output, kCopyTimeout,
        base::BindPostTaskToCurrentDefault(base::BindOnce(
            [](base::WeakPtr<BreezerPrivateCaptureCurrentPdfContextFunction>
                   function,
               int tab_id, content::WeakDocumentPtr tab_document,
               content::WeakDocumentPtr pdf_document,
               const content::CopyFromSurfaceResult& result) {
              if (function) {
                function->OnCopied(tab_id, std::move(tab_document),
                                   std::move(pdf_document),
                                   result ? result->bitmap : SkBitmap());
              }
            },
            weak_factory_.GetWeakPtr(), tab_id,
            contents->GetPrimaryMainFrame()->GetWeakDocumentPtr(),
            pdf_frame->GetWeakDocumentPtr())));
    return RespondLater();
  }
#endif  // BUILDFLAG(ENABLE_PDF)

  base::DictValue context;
  context.Set("isPdf", false);
  return RespondNow(WithArguments(std::move(context)));
}

#if BUILDFLAG(ENABLE_PDF)

void BreezerPrivateCaptureCurrentPdfContextFunction::OnCopied(
    int tab_id,
    content::WeakDocumentPtr tab_document,
    content::WeakDocumentPtr pdf_document,
    const SkBitmap& bitmap) {
  if (did_respond()) {
    return;
  }
  // Stopping the timer releases its reference to the request.
  const scoped_refptr<BreezerPrivateCaptureCurrentPdfContextFunction>
      keep_alive(this);
  timeout_.Stop();
  content::WebContents* const contents = GetActiveTab(GetCallerBrowser(), tab_id);
  content::RenderFrameHost* const frame = pdf_document.AsRenderFrameHostIfValid();
  if (!contents || !IsVisible(*contents) || !frame ||
      tab_document.AsRenderFrameHostIfValid() !=
          contents->GetPrimaryMainFrame() ||
      frame != GetPdfFrame(*contents)) {
    Respond(Error("The PDF changed before capture finished. Try again."));
    return;
  }

  if (bitmap.drawsNothing() || bitmap.width() > kMaxPdfImageEdge ||
      bitmap.height() > kMaxPdfImageEdge) {
    Respond(Error("The PDF viewport could not be captured. Try again."));
    return;
  }
  auto jpeg = gfx::JPEGCodec::Encode(bitmap, /*quality=*/85);
  if (!jpeg || jpeg->empty() || jpeg->size() > kMaxPdfImageBytes) {
    Respond(Error("The PDF viewport could not be encoded. Try again."));
    return;
  }

  base::DictValue context;
  context.Set("isPdf", true);
  context.Set("imageDataUrl",
              "data:image/jpeg;base64," + base::Base64Encode(*jpeg));
  Respond(WithArguments(std::move(context)));
}

void BreezerPrivateCaptureCurrentPdfContextFunction::OnTimeout() {
  if (!did_respond()) {
    Respond(Error("PDF capture timed out. Try again."));
  }
}

#endif  // BUILDFLAG(ENABLE_PDF)

}  // namespace extensions
