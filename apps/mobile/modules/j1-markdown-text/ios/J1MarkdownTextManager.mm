#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface J1MarkdownTextManager : RCTViewManager
@end

@implementation J1MarkdownTextManager

RCT_EXPORT_MODULE(J1MarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface J1MarkdownTextRunManager : RCTViewManager
@end

@implementation J1MarkdownTextRunManager

RCT_EXPORT_MODULE(J1MarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
