import { BoardPage } from "@/pages/BoardPage";

export function meta() {
  return [{ title: "Board · Tracker" }];
}

export default function BoardRoute() {
  return <BoardPage />;
}
