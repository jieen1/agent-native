import { useState, useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useCreateWorkItem, useProjects } from "@/hooks/use-tracker";
import { toast } from "sonner";

const TYPES = ["requirement", "task", "defect", "incident", "epic"] as const;

export function NewWorkItemDialog({
  children,
  defaultProjectId,
}: {
  children: ReactNode;
  defaultProjectId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("requirement");
  const [description, setDescription] = useState("");
  const create = useCreateWorkItem();
  const navigate = useNavigate();
  const { data: projectsData } = useProjects();
  const projects = Array.isArray(projectsData) ? projectsData : [];

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? (projects[0]?.id ?? ""));
    }
  }, [open, defaultProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    if (!projectId) {
      toast.error("请选择项目");
      return;
    }
    if (!title.trim()) {
      toast.error("标题不能为空");
      return;
    }
    create.mutate(
      {
        projectId,
        title: title.trim(),
        type: type as (typeof TYPES)[number],
        description: description.trim(),
      },
      {
        onSuccess: (it: { id: string }) => {
          toast.success("Work item created");
          setOpen(false);
          setTitle("");
          setDescription("");
          setType("requirement");
          navigate(`/items/${it.id}`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建工作项</DialogTitle>
          <DialogDescription>
            描述需求内容。仓库和分支来自项目配置，工作项本身不携带仓库信息。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>项目</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.key} · {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>类型</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="item-title">标题</Label>
            <Input
              id="item-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：添加健康检查接口"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="item-req">需求描述</Label>
            <Textarea
              id="item-req"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="描述编排器 Brain 需要构建的内容，无需仓库——将从项目获取。"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "创建中..." : "创建工作项"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
