import { useEffect, useState } from "react";
import { useTheme } from "../providers/theme";

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
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);

    return () => clearInterval(id);
  }, []);

  return <text fg={colors.primary}>{FRAMES[frame]}</text>;
}
