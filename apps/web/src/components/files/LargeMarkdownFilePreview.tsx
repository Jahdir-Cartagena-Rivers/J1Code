import type { ScopedThreadRef } from "@j1code/contracts";
import { useImperativeHandle, type ReactNode, type RefObject } from "react";

import { ChunkedMarkdown } from "./ChunkedMarkdown";
import { useFullFileMarkdown, useFullFileText } from "./fullFileText";

interface LargeMarkdownProps {
  readonly src: string;
  readonly preview: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly copyContents: RefObject<(() => Promise<string>) | null>;
  readonly sourceFallback: ReactNode;
}

export default function LargeMarkdownFilePreview(props: LargeMarkdownProps) {
  const file = useFullFileText(props.src, props.preview);
  if (file === "too-large" || file === "failed") return props.sourceFallback;
  return <RenderedFile {...props} file={file} />;
}

function RenderedFile(
  props: LargeMarkdownProps & { readonly file: { readonly text: string; readonly done: boolean } },
) {
  const { file } = props;
  const markdown = useFullFileMarkdown(props.src, file.text);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      file.done
        ? Promise.resolve(file.text)
        : Promise.reject(new Error("The file is still loading. Try again in a moment.")),
    [file],
  );
  return (
    <ChunkedMarkdown
      {...markdown}
      loading={!file.done}
      cwd={props.cwd}
      relativePath={props.relativePath}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
    />
  );
}
