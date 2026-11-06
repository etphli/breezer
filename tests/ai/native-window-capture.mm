// Capture only windows owned by this disposable browser process. The current-
// process ScreenCaptureKit API does not request access to another application's
// windows or require the Computer Use service.
#import <Cocoa/Cocoa.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <unistd.h>
#include <spawn.h>
#include <errno.h>
#include <cstring>
#include <atomic>

static NSString* captureRoot;
static BOOL capturePending = NO;
static std::atomic<unsigned> blockedHostLaunches{0};
static void Reply(NSDictionary* result);
static SCStream* recordingStream;
static SCRecordingOutput* recordingOutput;

@interface NativeRecordingDelegate : NSObject <SCRecordingOutputDelegate>
@property(nonatomic, copy) NSString* path;
@end
@implementation NativeRecordingDelegate
- (void)recordingOutputDidStartRecording:(SCRecordingOutput*)output {
  Reply(@{@"ok": @YES, @"recordingStarted": @YES, @"path": self.path});
}
- (void)recordingOutput:(SCRecordingOutput*)output didFailWithError:(NSError*)error {
  Reply(@{@"ok": @NO, @"error": error.localizedDescription});
}
- (void)recordingOutputDidFinishRecording:(SCRecordingOutput*)output {
  Reply(@{@"ok": @YES, @"recordingFinished": @YES, @"path": self.path,
          @"durationSeconds": @(CMTimeGetSeconds(output.recordedDuration)),
          @"bytes": @(output.recordedFileSize)});
}
@end
static NativeRecordingDelegate* recordingDelegate;

// Native UI review must not start a helper that reads the user's global
// integrations or CLI accounts. Restrict only this explicitly instrumented
// process; no installed executable or global setting is changed.
static bool IsPrivateHost(const char* path, char* const argv[]) {
  if (!getenv("BREEZER_UI_NATIVE_CAPTURE_DIR")) return false;
  if (const char* app = getenv("BREEZER_UI_NATIVE_SPAWN_ROOT")) {
    // A verification build may contain older host lookup code. Permit only
    // its own browser helpers, plus the fixed spawn self-test executable.
    if (!path || (strcmp(path, "/usr/bin/true") != 0 &&
                  (strncmp(path, app, strlen(app)) != 0 ||
                   path[strlen(app)] != '/'))) return true;
    if (strstr(path, "/breezer_ai/")) return true;
  }
  if (path && strstr(path, "/breezer_ai/host/launch.sh")) return true;
  for (unsigned i = 0; argv && argv[i] && i < 64; ++i) if (strstr(argv[i], "/breezer_ai/host/launch.sh")) return true;
  return false;
}
static int ReviewSpawn(pid_t* pid, const char* path, const posix_spawn_file_actions_t* actions, const posix_spawnattr_t* attr, char* const argv[], char* const envp[]) {
  if (IsPrivateHost(path, argv)) { ++blockedHostLaunches; return EPERM; }
  return posix_spawn(pid, path, actions, attr, argv, envp);
}
static int ReviewSpawnp(pid_t* pid, const char* path, const posix_spawn_file_actions_t* actions, const posix_spawnattr_t* attr, char* const argv[], char* const envp[]) {
  if (IsPrivateHost(path, argv)) { ++blockedHostLaunches; return EPERM; }
  return posix_spawnp(pid, path, actions, attr, argv, envp);
}
__attribute__((used)) static const struct { const void* replacement; const void* original; } spawnInterposes[] __attribute__((section("__DATA,__interpose"))) = {
  {reinterpret_cast<const void*>(&ReviewSpawn), reinterpret_cast<const void*>(&posix_spawn)},
  {reinterpret_cast<const void*>(&ReviewSpawnp), reinterpret_cast<const void*>(&posix_spawnp)},
};

static void Reply(NSDictionary* result) {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{ Reply(result); });
    return;
  }
  NSMutableDictionary* data = [result mutableCopy];
  data[@"pid"] = @(getpid());
  data[@"blockedNativeHostLaunches"] = @(blockedHostLaunches.load());
  data[@"screenCaptureAccessGranted"] = @(CGPreflightScreenCaptureAccess());
  NSData* json = [NSJSONSerialization dataWithJSONObject:data options:NSJSONWritingSortedKeys error:nil];
  [json writeToFile:[captureRoot stringByAppendingPathComponent:@"reply.json"] atomically:YES];
  capturePending = NO;
}

static void Capture(NSString* name, BOOL record) API_AVAILABLE(macos(14.4)) {
  [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent* content, NSError* error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error) { Reply(@{@"ok": @NO, @"error": error.localizedDescription}); return; }
      SCWindow* selected = nil;
      NSInteger keyWindow = NSApp.keyWindow.windowNumber;
      for (SCWindow* window in content.windows) {
        if (window.windowLayer != 0 || window.frame.size.width < 400 || window.frame.size.height < 300) continue;
        if (window.windowID == keyWindow) { selected = window; break; }
        if (!selected || window.frame.size.width * window.frame.size.height > selected.frame.size.width * selected.frame.size.height) selected = window;
      }
      if (!selected) { Reply(@{@"ok": @NO, @"error": @"No owned browser window is available"}); return; }
      SCContentFilter* filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected];
      SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
      config.width = selected.frame.size.width * filter.pointPixelScale;
      config.height = selected.frame.size.height * filter.pointPixelScale;
      config.sourceRect = CGRectMake(0, 0, selected.frame.size.width, selected.frame.size.height);
      config.showsCursor = NO;
      config.ignoreShadowsSingleWindow = YES;
      config.ignoreGlobalClipSingleWindow = YES;
      config.includeChildWindows = NO;
      config.captureResolution = SCCaptureResolutionBest;
      NSDictionary* geometry = @{@"windowId": @(selected.windowID), @"width": @(selected.frame.size.width), @"height": @(selected.frame.size.height), @"scale": @(filter.pointPixelScale), @"title": selected.title ?: @""};
      if (record) {
        if (@available(macOS 15.0, *)) {
          if (recordingStream) { Reply(@{@"ok": @NO, @"error": @"Recording already active"}); return; }
          config.minimumFrameInterval = CMTimeMake(1, 30);
          config.capturesAudio = NO;
          config.captureMicrophone = NO;
          recordingDelegate = [[NativeRecordingDelegate alloc] init];
          recordingDelegate.path = [captureRoot stringByAppendingPathComponent:[name stringByAppendingString:@".mp4"]];
          SCRecordingOutputConfiguration* outputConfig = [[SCRecordingOutputConfiguration alloc] init];
          outputConfig.outputURL = [NSURL fileURLWithPath:recordingDelegate.path];
          recordingOutput = [[SCRecordingOutput alloc] initWithConfiguration:outputConfig delegate:recordingDelegate];
          recordingStream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
          NSError* outputError = nil;
          if (![recordingStream addRecordingOutput:recordingOutput error:&outputError]) { recordingStream = nil; Reply(@{@"ok": @NO, @"error": outputError.localizedDescription}); return; }
          [recordingStream startCaptureWithCompletionHandler:^(NSError* startError) {
            if (startError) Reply(@{@"ok": @NO, @"error": startError.localizedDescription});
          }];
        } else Reply(@{@"ok": @NO, @"error": @"Native recording requires macOS 15 or newer"});
        return;
      }
      [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef image, NSError* captureError) {
        if (captureError || !image) { Reply(@{@"ok": @NO, @"error": captureError.localizedDescription ?: @"Capture returned no image"}); return; }
        NSString* path = [captureRoot stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
        CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], CFSTR("public.png"), 1, NULL);
        if (!destination) { Reply(@{@"ok": @NO, @"error": @"Could not create the capture file"}); return; }
        CGImageDestinationAddImage(destination, image, NULL);
        BOOL saved = CGImageDestinationFinalize(destination);
        CFRelease(destination);
        Reply(@{@"ok": @(saved), @"path": path, @"geometry": geometry, @"pixelWidth": @(CGImageGetWidth(image)), @"pixelHeight": @(CGImageGetHeight(image)), @"api": @"ScreenCaptureKit current-process window"});
      }];
    });
  }];
}

__attribute__((constructor)) static void InstallCaptureHook() {
  @autoreleasepool {
    const char* configured = getenv("BREEZER_UI_NATIVE_CAPTURE_DIR");
    if (!configured) return;
    if (![NSProcessInfo.processInfo.processName isEqualToString:@"Breezer"]) return;
    for (NSString* argument in NSProcessInfo.processInfo.arguments) if ([argument hasPrefix:@"--type="]) return;
    captureRoot = [NSString stringWithUTF8String:configured];
    dispatch_async(dispatch_get_main_queue(), ^{
      Reply(@{@"ok": @YES, @"hookLoaded": @YES});
      [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer*) {
        if (capturePending) return;
        NSString* request = [captureRoot stringByAppendingPathComponent:@"request.json"];
        NSData* bytes = [NSData dataWithContentsOfFile:request];
        if (!bytes) return;
        [[NSFileManager defaultManager] removeItemAtPath:request error:nil];
        NSDictionary* message = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
        NSString* name = message[@"name"];
        NSCharacterSet* invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet];
        if (![name isKindOfClass:NSString.class] || name.length == 0 || name.length > 100 || [name rangeOfCharacterFromSet:invalid].location != NSNotFound) { Reply(@{@"ok": @NO, @"error": @"Invalid capture name"}); return; }
        capturePending = YES;
        NSString* method = message[@"method"];
        if ([method isEqualToString:@"prepare"]) {
          for (NSWindow* window in NSApp.windows) if (window.frame.size.width >= 400) {
            window.collectionBehavior |= NSWindowCollectionBehaviorMoveToActiveSpace;
            [window makeKeyAndOrderFront:nil];
          }
          [NSApp activateIgnoringOtherApps:YES];
          Reply(@{@"ok": @YES, @"prepared": @YES});
          return;
        }
        if ([method isEqualToString:@"record-stop"]) {
          if (!recordingStream) { Reply(@{@"ok": @NO, @"error": @"No recording active"}); return; }
          [recordingStream stopCaptureWithCompletionHandler:^(NSError* stopError) {
            if (stopError) Reply(@{@"ok": @NO, @"error": stopError.localizedDescription});
          }];
          return;
        }
        if (![method isEqualToString:@"screen"] && ![method isEqualToString:@"record-start"]) { Reply(@{@"ok": @NO, @"error": @"Unknown capture method"}); return; }
        if (@available(macOS 14.4, *)) Capture(name, [method isEqualToString:@"record-start"]);
        else Reply(@{@"ok": @NO, @"error": @"Native capture requires macOS 14.4 or newer"});
      }];
    });
  }
}
