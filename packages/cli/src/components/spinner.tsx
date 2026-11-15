import { useEffect, useState } from "react";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "@nightcode/database/enums";

// Same frames as cli-spinners' "aesthetic". We render them ourselves instead of
// using the opentui-spinner package, which only supports @opentui/core ^0.3.x
// and throws on the 0.8.x we use.
const FRAMES = [
  "▰▱▱▱▱▱▱",
  "▰▰▱▱▱▱▱",
  "▰▰▰▱▱▱▱",
  "▰▰▰▰▱▱▱",
  "▰▰▰▰▰▱▱",
  "▰▰▰▰▰▰▱",
  "▰▰▰▰▰▰▰",
  "▰▱▱▱▱▱▱",
];
const FRAME_INTERVAL_MS = 80;

export function Spinner() {
  const { colors } = useTheme();
  const { mode } = usePromptConfig();
  const [frame, setFrame] = useState(0);
  const activeColor = mode === Mode.PLAN ? colors.planMode : colors.primary;

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);

    return () => clearInterval(id);
  }, []);

  return <text fg={activeColor}>{FRAMES[frame]}</text>;
}
