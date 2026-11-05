#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#include <cmath>
int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (argc != 3) return 2;
    NSString* input = [NSString stringWithUTF8String:argv[1]];
    NSString* directory = [NSString stringWithUTF8String:argv[2]];
    NSError* error = nil;
    if (![[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:NO attributes:nil error:&error]) { NSLog(@"%@", error); return 3; }
    AVURLAsset* asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:input] options:nil];
    AVAssetTrack* track = [[asset tracksWithMediaType:AVMediaTypeVideo] firstObject];
    if (!track) return 4;
    AVAssetReader* reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    AVAssetReaderTrackOutput* output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:@{(id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)}];
    output.alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:output]) return 5;
    [reader addOutput:output];
    if (![reader startReading]) return 6;
    CIContext* context = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @YES}];
    NSMutableArray* frames = [NSMutableArray array];
    CMSampleBufferRef sample;
    size_t width = 0, height = 0;
    while ((sample = [output copyNextSampleBuffer])) {
      @autoreleasepool {
        CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
        CIImage* image = [CIImage imageWithCVPixelBuffer:pixels];
        width = CVPixelBufferGetWidth(pixels); height = CVPixelBufferGetHeight(pixels);
        CGImageRef full = [context createCGImage:image fromRect:CGRectMake(0, 0, width, height)];
        CGImageRef header = CGImageCreateWithImageInRect(full, CGRectMake(0, 0, width, MIN(height, 160)));
        NSString* name = [NSString stringWithFormat:@"native-dense-%03lu.png", (unsigned long)frames.count];
        NSURL* url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:name]];
        CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.png"), 1, NULL);
        if (!destination) return 7;
        CGImageDestinationAddImage(destination, header, NULL);
        BOOL saved = CGImageDestinationFinalize(destination);
        CFRelease(destination); CGImageRelease(header); CGImageRelease(full);
        if (!saved) return 8;
        double duration = CMTimeGetSeconds(CMSampleBufferGetDuration(sample)) * 1000;
        [frames addObject:@{@"file": name, @"presentationTimeMs": @(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000), @"durationMs": std::isfinite(duration) ? @(duration) : NSNull.null}];
        CFRelease(sample);
      }
    }
    if (reader.status != AVAssetReaderStatusCompleted) { NSLog(@"%@", reader.error); return 9; }
    NSDictionary* report = @{@"source": input, @"assetDurationMs": @(CMTimeGetSeconds(asset.duration) * 1000), @"sourceWidth": @(width), @"sourceHeight": @(height), @"crop": @[@0, @0, @(width), @160], @"frames": frames, @"method": @"Every decoded AVAssetReader sample with its actual presentation timestamp. Native header pixels only; no synthetic in-between frames. This does not establish input latency or application frame pacing."};
    NSData* json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:&error];
    if (![json writeToFile:[directory stringByAppendingPathComponent:@"frames.json"] atomically:YES]) return 10;
    printf("Decoded %lu actual native frames\n", (unsigned long)frames.count);
  }
}
