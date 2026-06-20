import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Shared data table (FRONTEND §C3 — "wrap in one <DataTable>"). A thin, typed
// wrapper over the shadcn table primitive with header, loading skeleton rows,
// an empty slot, and optional row click. Kept deliberately small; richer
// sort/virtualization can layer on later without changing call sites.
export interface DataTableColumn<T> {
  /** Stable column id (also the React key). */
  id: string;
  header: ReactNode;
  /** Render the cell for a row. */
  cell: (row: T) => ReactNode;
  className?: string;
  headClassName?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  isLoading?: boolean;
  /** Shown (spanning all columns) when there are no rows and not loading. */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Number of skeleton rows while loading. */
  skeletonRows?: number;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  isLoading = false,
  empty,
  onRowClick,
  skeletonRows = 5,
}: DataTableProps<T>) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.id} className={col.headClassName}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: skeletonRows }).map((_, i) => (
              <TableRow key={`sk-${i}`}>
                {columns.map((col) => (
                  <TableCell key={col.id} className={col.className}>
                    <Skeleton className="h-4 w-full max-w-[160px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-32 p-0 text-center align-middle"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && "cursor-pointer")}
              >
                {columns.map((col) => (
                  <TableCell key={col.id} className={col.className}>
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
