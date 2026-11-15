#pragma once

#include <react/renderer/components/J1MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/J1MarkdownTextSpec/Props.h>
#include <react/renderer/components/J1MarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char J1MarkdownTextRunComponentName[];

using J1MarkdownTextRunShadowNode = ConcreteViewShadowNode<
    J1MarkdownTextRunComponentName,
    J1MarkdownTextRunProps,
    J1MarkdownTextRunEventEmitter,
    J1MarkdownTextRunState>;
}
