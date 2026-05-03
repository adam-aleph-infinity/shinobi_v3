"use client";

import CRMBrowserPage from "@/components/crm/CRMBrowserPage";

export default function AgentDeepDivePage() {
  return (
    <CRMBrowserPage
      artifactMode={true}
      deepDiveMode={true}
      title="Agent Deep Dive"
      subtitle="Cross-tab artifacts by agent/customer/pipeline scopes"
    />
  );
}
