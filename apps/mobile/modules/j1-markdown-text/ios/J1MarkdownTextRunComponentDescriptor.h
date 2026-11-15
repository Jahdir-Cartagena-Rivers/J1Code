#pragma once

#include "J1MarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using J1MarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<J1MarkdownTextRunShadowNode>;

void J1MarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
