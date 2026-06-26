import { TeamPage } from "@agent-native/core/client/org";
import { useSetPageTitle } from "@/components/layout/HeaderActions";

export function meta() {
  return [{ title: "团队" }];
}

export default function TeamRoute() {
  useSetPageTitle("团队");
  return (
    <div className="p-8">
      <TeamPage createOrgDescription="创建团队,与他人一起共享项目和工作项。" />
    </div>
  );
}
