import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The "J1" brand mark, matching the desktop sidebar's J1Wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function J1Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 96 / 64;
  return (
    <Svg
      accessibilityLabel="J1"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 96 64"
    >
      <ThemedPath
        d="M12 4H50V44C50 57 42 64 27 64C12 64 4 57 4 44V39H18V44C18 50 21 53 27 53C33 53 36 50 36 44V16H12ZM64 14L78 4H90V52H96V64H62V52H76V20L64 28Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
