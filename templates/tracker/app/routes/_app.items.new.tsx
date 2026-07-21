import { NewWorkItemPage } from "@/pages/NewWorkItemPage";

export function meta() {
  return [{ title: "新建工作项 · Tracker" }];
}

export default function NewWorkItemRoute() {
  return <NewWorkItemPage />;
}
