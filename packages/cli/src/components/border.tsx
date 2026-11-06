export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizantal: "",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: ",",
};

export const SplitBorder = {
    border: ["left" as const, "right" as const],
    customBorderChars: {
        ...EmptyBorder,
        vertical: "┃",
    }
}