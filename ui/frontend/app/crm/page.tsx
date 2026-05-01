import CRMBrowserPage from "@/components/crm/CRMBrowserPage";

type SearchParams = Record<string, string | string[] | undefined>;

function getSearchParam(searchParams: SearchParams | undefined, key: string): string {
  const raw = searchParams?.[key];
  if (Array.isArray(raw)) return String(raw[0] || "");
  return String(raw || "");
}

export default function CRMPage({ searchParams }: { searchParams?: SearchParams }) {
  const embedded = getSearchParam(searchParams, "embedded") === "1";
  const mode = getSearchParam(searchParams, "mode");
  const pairPickerMode = embedded && mode === "pick_pair";
  const prefillAgent = getSearchParam(searchParams, "agent");
  const prefillCustomer = getSearchParam(searchParams, "customer");

  return (
    <CRMBrowserPage
      artifactMode={false}
      title="CRM Browser"
      subtitle="Browse agent-customer pairs across all CRMs"
      pairPickerMode={pairPickerMode}
      prefillAgent={prefillAgent}
      prefillCustomer={prefillCustomer}
    />
  );
}
