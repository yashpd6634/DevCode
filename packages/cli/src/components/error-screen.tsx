import { isRouteErrorResponse, useRouteError } from "react-router";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";

// React Router's built-in error page renders plain HTML tags, which OpenTUI
// rejects ("Text must be created inside of a text node") and which hides the
// real error. This renders the error safely inside <text>.
export function ErrorScreen() {
  const error = useRouteError();
  const { colors } = useTheme();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);

  return (
    <box flexDirection="column" padding={2} gap={1} width="100%">
      <text fg={colors.error}>Something went wrong</text>
      <text wrapMode="word" width="100%">
        {message}
      </text>
      <text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
    </box>
  );
}
