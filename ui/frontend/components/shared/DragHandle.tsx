export function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1.5 flex-shrink-0 cursor-col-resize hover:bg-indigo-500/30 rounded transition-colors select-none"
    />
  );
}
