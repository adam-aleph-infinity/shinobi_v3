"use client";

import CRMBrowserPage from "@/components/crm/CRMBrowserPage";

export default function CRMPage() {
  return (
    <CRMBrowserPage
      artifactMode={false}
      title="CRM Browser"
      subtitle="Browse agent-customer pairs across all CRMs"
    />
  );
}
