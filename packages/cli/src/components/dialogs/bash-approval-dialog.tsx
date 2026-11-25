import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";

export type BashApprovalDecision = "allow" | "allow-session" | "deny";

type Option = {
  decision: BashApprovalDecision;
  hotkey: string;
  label: string;
};

const OPTIONS: Option[] = [
  { decision: "allow", hotkey: "y", label: "Yes, run it" },
  {
    decision: "allow-session",
    hotkey: "a",
    label: "Yes, and don't ask again this session",
  },
  { decision: "deny", hotkey: "n", label: "No" },
];

type BashApprovalDialogContentProps = {
  command: string;
  description?: string;
  cwd: string;
  onDecide: (decision: BashApprovalDecision) => void;
};

export function BashApprovalDialogContent({
  command,
  description,
  cwd,
  onDecide,
}: BashApprovalDialogContentProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    if (key.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "down") {
      setSelectedIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
    } else if (key.name === "return" || key.name === "enter") {
      onDecide(OPTIONS[selectedIndex]!.decision);
    } else {
      const option = OPTIONS.find((o) => o.hotkey === key.name);
      if (option) onDecide(option.decision);
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      {description ? (
        <text wrapMode="word" width="100%">
          {description}
        </text>
      ) : null}

      <box
        border={["left"]}
        borderColor={colors.info}
        paddingX={1}
        width="100%"
      >
        <text wrapMode="char" width="100%" fg={colors.info}>
          {command}
        </text>
      </box>

      <text attributes={TextAttributes.DIM} wrapMode="char" width="100%">
        in {cwd}
      </text>

      <box flexDirection="column">
        {OPTIONS.map((option, i) => {
          const isSelected = i === selectedIndex;
          return (
            <box
              key={option.decision}
              height={1}
              flexDirection="row"
              backgroundColor={isSelected ? colors.selection : undefined}
              onMouseMove={() => setSelectedIndex(i)}
              onMouseDown={() => onDecide(option.decision)}
            >
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {` ${option.hotkey}  ${option.label}`}
              </text>
            </box>
          );
        })}
      </box>
    </box>
  );
}
