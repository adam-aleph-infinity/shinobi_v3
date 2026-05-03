import { redirect } from "next/navigation";

export default function ArtifactsPageRemoved() {
  redirect("/pipeline");
}
