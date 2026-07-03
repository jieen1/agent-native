import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { useProjects } from "@/hooks/use-tracker";
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconLoader2,
  IconPlus,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";

export function meta() {
  return [{ title: "项目设置 · Tracker" }];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ProjectRepo {
  id: string;
  projectId: string;
  name: string;
  gitRemote: string;
  baseBranch: string;
  testCmdUnit: string;
  testCmdFull: string;
  e2eTestPath: string;
  integrationTestPath: string;
  buildTool: string;
  ciMode: string;
  gateMode: string;
  devModel: string | null;
  createdAt: string;
  updatedAt: string;
}

type RepoFormState = {
  name: string;
  gitRemote: string;
  baseBranch: string;
  testCmdUnit: string;
  testCmdFull: string;
  e2eTestPath: string;
  integrationTestPath: string;
  buildTool: string;
  ciMode: string;
  gateMode: string;
  devModel: string;
};

const emptyRepoForm = (): RepoFormState => ({
  name: "",
  gitRemote: "",
  baseBranch: "main",
  testCmdUnit: "",
  testCmdFull: "",
  e2eTestPath: "",
  integrationTestPath: "",
  buildTool: "",
  ciMode: "none",
  gateMode: "tests-only",
  devModel: "",
});

// ---------------------------------------------------------------------------
// Repos section component
// ---------------------------------------------------------------------------
function ProjectReposSection({ projectId }: { projectId: string }) {
  const qc = useQueryClient();

  const { data: reposData, isLoading: reposLoading } = useActionQuery(
    "manage-project-repos",
    { projectId, op: "list" },
  ) as { data?: ProjectRepo[]; isLoading: boolean };

  const repos = Array.isArray(reposData) ? reposData : [];

  const manageRepo = useActionMutation("manage-project-repos", {
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["action", "manage-project-repos"],
      });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "操作失败";
      toast.error(msg);
    },
  });

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRepo, setEditingRepo] = useState<ProjectRepo | null>(null);
  const [form, setForm] = useState<RepoFormState>(emptyRepoForm());

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<ProjectRepo | null>(null);

  function openAdd() {
    setEditingRepo(null);
    setForm(emptyRepoForm());
    setDialogOpen(true);
  }

  function openEdit(repo: ProjectRepo) {
    setEditingRepo(repo);
    setForm({
      name: repo.name,
      gitRemote: repo.gitRemote ?? "",
      baseBranch: repo.baseBranch ?? "main",
      testCmdUnit: repo.testCmdUnit ?? "",
      testCmdFull: repo.testCmdFull ?? "",
      e2eTestPath: repo.e2eTestPath ?? "",
      integrationTestPath: repo.integrationTestPath ?? "",
      buildTool: repo.buildTool ?? "",
      ciMode: repo.ciMode ?? "none",
      gateMode: repo.gateMode ?? "tests-only",
      devModel: repo.devModel ?? "",
    });
    setDialogOpen(true);
  }

  function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("仓库名称不能为空");
      return;
    }
    const op = editingRepo ? "update" : "add";
    manageRepo.mutate(
      {
        projectId,
        op,
        repo: {
          name: form.name.trim(),
          gitRemote: form.gitRemote,
          baseBranch: form.baseBranch || "main",
          testCmdUnit: form.testCmdUnit,
          testCmdFull: form.testCmdFull,
          e2eTestPath: form.e2eTestPath,
          integrationTestPath: form.integrationTestPath,
          buildTool: form.buildTool,
          ciMode: form.ciMode as "none" | "github",
          gateMode: form.gateMode as "tests-only" | "stack" | "none",
          devModel: form.devModel || undefined,
        },
      },
      {
        onSuccess: () => {
          setDialogOpen(false);
          toast.success(editingRepo ? "仓库已更新" : "仓库已添加");
        },
      },
    );
  }

  function handleDelete() {
    if (!deleteTarget) return;
    manageRepo.mutate(
      {
        projectId,
        op: "remove",
        repo: { name: deleteTarget.name },
      },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          toast.success("仓库已删除");
        },
      },
    );
  }

  function setField<K extends keyof RepoFormState>(
    key: K,
    value: RepoFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <>
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">代码仓库</CardTitle>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={openAdd}>
            <IconPlus className="size-4" />
            添加仓库
          </Button>
        </CardHeader>
        <CardContent>
          {reposLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : repos.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              暂无代码仓库，点击「添加仓库」注册第一个仓库
            </div>
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>Git 远程</TableHead>
                    <TableHead>分支</TableHead>
                    <TableHead>CI 模式</TableHead>
                    <TableHead>门控策略</TableHead>
                    <TableHead>完整测试命令</TableHead>
                    <TableHead>Dev 模型</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repos.map((repo) => (
                    <TableRow key={repo.id}>
                      <TableCell className="font-mono text-sm font-medium">
                        {repo.name}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate font-mono text-xs text-muted-foreground">
                        {repo.gitRemote || "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {repo.baseBranch || "main"}
                      </TableCell>
                      <TableCell className="text-xs">{repo.ciMode}</TableCell>
                      <TableCell className="text-xs">{repo.gateMode}</TableCell>
                      <TableCell className="max-w-[140px] truncate font-mono text-xs text-muted-foreground">
                        {repo.testCmdFull || "—"}
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-xs text-muted-foreground">
                        {repo.devModel || "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            onClick={() => openEdit(repo)}
                          >
                            <IconPencil className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7 text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(repo)}
                          >
                            <IconTrash className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRepo ? "编辑仓库" : "添加仓库"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>仓库名称 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="demo-app"
                disabled={!!editingRepo}
                className="font-mono text-sm"
              />
              {editingRepo && (
                <p className="text-xs text-muted-foreground">名称不可修改</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Git 远程仓库</Label>
              <Input
                value={form.gitRemote}
                onChange={(e) => setField("gitRemote", e.target.value)}
                placeholder="https://github.com/org/repo"
                className="font-mono text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>基础分支</Label>
                <Input
                  value={form.baseBranch}
                  onChange={(e) => setField("baseBranch", e.target.value)}
                  placeholder="main"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label>构建工具</Label>
                <Input
                  value={form.buildTool}
                  onChange={(e) => setField("buildTool", e.target.value)}
                  placeholder="npm / pnpm / gradle"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>CI 模式</Label>
                <Select
                  value={form.ciMode}
                  onValueChange={(v) => setField("ciMode", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">none</SelectItem>
                    <SelectItem value="github">github</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>门控策略</Label>
                <Select
                  value={form.gateMode}
                  onValueChange={(v) => setField("gateMode", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tests-only">tests-only</SelectItem>
                    <SelectItem value="stack">stack</SelectItem>
                    <SelectItem value="none">none</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>单元测试命令</Label>
              <Input
                value={form.testCmdUnit}
                onChange={(e) => setField("testCmdUnit", e.target.value)}
                placeholder="npm run test:unit"
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label>完整测试命令</Label>
              <Input
                value={form.testCmdFull}
                onChange={(e) => setField("testCmdFull", e.target.value)}
                placeholder="npm test"
                className="font-mono text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>E2E 测试路径</Label>
                <Input
                  value={form.e2eTestPath}
                  onChange={(e) => setField("e2eTestPath", e.target.value)}
                  placeholder="e2e/"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label>集成测试路径</Label>
                <Input
                  value={form.integrationTestPath}
                  onChange={(e) =>
                    setField("integrationTestPath", e.target.value)
                  }
                  placeholder="tests/integration/"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Dev 模型 (可选)</Label>
              <Input
                value={form.devModel}
                onChange={(e) => setField("devModel", e.target.value)}
                placeholder="claude-sonnet-4-5"
                className="font-mono text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={manageRepo.isPending || !form.name.trim()}
            >
              {manageRepo.isPending ? (
                <IconLoader2 className="mr-1.5 size-4 animate-spin" />
              ) : null}
              {editingRepo ? "保存更改" : "添加仓库"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除仓库</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除仓库「{deleteTarget?.name}」吗？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={manageRepo.isPending}
            >
              {manageRepo.isPending ? (
                <IconLoader2 className="mr-1.5 size-4 animate-spin" />
              ) : null}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main project settings page
// ---------------------------------------------------------------------------
export default function ProjectSettingsRoute() {
  const { id = "" } = useParams();
  const { data, isLoading } = useProjects();
  const projects = Array.isArray(data) ? data : [];
  const project = projects.find((p) => p.id === id);

  const qc = useQueryClient();
  const update = useActionMutation("update-project", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-projects"] });
      toast.success("项目已保存");
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "保存失败";
      toast.error(msg);
    },
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gitRemote, setGitRemote] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  useEffect(() => {
    if (project) {
      setName(project.name ?? "");
      setDescription(project.description ?? "");
      setGitRemote((project as any).gitRemote ?? "");
      setDefaultBranch((project as any).defaultBranch ?? "main");
    }
  }, [project?.id]);

  function handleSave() {
    if (!project) return;
    update.mutate({
      id,
      name: name.trim() || undefined,
      description,
      gitRemote,
      defaultBranch: defaultBranch || "main",
    });
  }

  return (
    <div className="mx-auto max-w-2xl p-5 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4 gap-1.5">
        <Link to="/projects">
          <IconArrowLeft className="size-4" /> 项目列表
        </Link>
      </Button>

      {isLoading && !project ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : !project ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          项目不存在或无权访问
        </div>
      ) : (
        <>
          <div className="mb-6 flex items-center gap-3">
            <span className="inline-flex h-6 items-center rounded bg-muted px-2 font-mono text-xs font-semibold text-muted-foreground">
              {(project as any).key}
            </span>
            <h1 className="text-xl font-semibold">{project.name}</h1>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">项目设置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="proj-name">项目名称</Label>
                <Input
                  id="proj-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="项目名称"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="proj-desc">项目描述</Label>
                <Textarea
                  id="proj-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="简述项目目标和范围…"
                  rows={3}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="proj-remote">Git 远程仓库</Label>
                <Input
                  id="proj-remote"
                  value={gitRemote}
                  onChange={(e) => setGitRemote(e.target.value)}
                  placeholder="https://github.com/org/repo"
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="proj-branch">默认分支</Label>
                <Input
                  id="proj-branch"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  placeholder="main"
                  className="font-mono text-sm"
                />
              </div>

              <Button
                className="gap-1.5"
                onClick={handleSave}
                disabled={update.isPending || !name.trim()}
              >
                {update.isPending ? (
                  <IconLoader2 className="size-4 animate-spin" />
                ) : (
                  <IconDeviceFloppy className="size-4" />
                )}
                保存更改
              </Button>
            </CardContent>
          </Card>

          {/* Repos section */}
          <ProjectReposSection projectId={id} />
        </>
      )}
    </div>
  );
}
