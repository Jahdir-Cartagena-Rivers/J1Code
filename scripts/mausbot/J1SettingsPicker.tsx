import { Children, isValidElement, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

type Choice = { value?: string; label?: string; disabled?: boolean; children?: ReactNode };

/** The settings navigator uses the app's menu, including its focus and dismissal behavior. */
export function J1SettingsPicker({
  value,
  onSelect,
  children,
  ...props
}: {
  value: string;
  onSelect: (value: string) => void;
  children: ReactNode;
  className?: string;
  "aria-label": string;
}) {
  const items: SidebarMenuItem[] = [];
  const collect = (nodes: ReactNode, heading?: string) => {
    let first = true;
    for (const node of Children.toArray(nodes)) {
      if (!isValidElement<Choice>(node)) continue;
      if (node.type === "optgroup") {
        collect(node.props.children, node.props.label);
      } else if (node.type === "option" && typeof node.props.value === "string") {
        const key = node.props.value;
        items.push({
          key,
          label: Children.toArray(node.props.children).join(""),
          checked: key === value,
          disabled: node.props.disabled,
          ...(first && heading ? { heading } : {}),
          onSelect: () => onSelect(key),
        });
        first = false;
      }
    }
  };
  collect(children);
  return (
    <div className={props.className}>
      <SidebarPopoverMenu
        items={items}
        ariaLabel={props["aria-label"]}
        triggerClassName="min-w-0 w-full"
        renderTrigger={() => (
          <span className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-hairline bg-card px-3 py-2 text-[15px] text-ink">
            <span className="truncate">{items.find((item) => item.key === value)?.label}</span>
            <ChevronDown size={16} className="shrink-0 text-ink-secondary" />
          </span>
        )}
      />
    </div>
  );
}
