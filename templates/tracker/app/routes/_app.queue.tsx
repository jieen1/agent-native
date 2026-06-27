import { QueuePage } from "@/pages/QueuePage";

export function meta() {
  return [{ title: "执行队列 · Tracker" }];
}

export default function QueueRoute() {
  return <QueuePage />;
}
