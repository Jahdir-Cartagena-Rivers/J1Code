#pragma once

#include <react/renderer/components/J1MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/J1MarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char J1MarkdownTextComponentName[];

struct J1MarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct J1MarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float J1MarkdownTextAttachmentSize(const J1MarkdownTextAttachmentRange &) {
  return 14;
}

inline Float J1MarkdownTextAttachmentBaselineOffset(
    const J1MarkdownTextAttachmentRange &) {
  return -2;
}

class J1MarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<J1MarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<J1MarkdownTextAttachmentRange> attachmentRanges;
};

class J1MarkdownTextShadowNode final : public ConcreteViewShadowNode<
J1MarkdownTextComponentName,
J1MarkdownTextProps,
J1MarkdownTextEventEmitter,
J1MarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  J1MarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<J1MarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<J1MarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
