import { cn } from "@/lib/utils";

const styles = {
  pending:  "bg-gray-700 text-gray-300",
  running:  "bg-blue-900 text-blue-300 animate-pulse",
  complete: "bg-green-900 text-green-300",
  failed:   "bg-red-900 text-red-300",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", styles[status as keyof typeof styles] || styles.pending)}>
      {status}
    </span>
  );
}
