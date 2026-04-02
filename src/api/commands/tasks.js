// @ts-check

import { registerCommand } from "../../core/command-registry.js";
import { getAllTasks, getTask, cancelTask, serializeTask } from "../../core/task.js";
import { jsonResponse } from "../router.js";

registerCommand({
  name: "tasks.list",
  method: "GET",
  path: "/api/tasks",
  handler: async () =>
    jsonResponse(200, {
      status: "ok",
      tasks: getAllTasks().map(serializeTask)
    })
});

registerCommand({
  name: "tasks.get",
  method: "GET",
  path: "/api/tasks/:id",
  handler: async (req) => {
    const id = String(req.params?.id ?? "").trim();
    const task = getTask(id);
    if (!task) {
      return jsonResponse(404, {
        status: "error",
        error: "Task not found"
      });
    }

    return jsonResponse(200, {
      status: "ok",
      task: serializeTask(task)
    });
  }
});

registerCommand({
  name: "tasks.cancel",
  method: "POST",
  path: "/api/tasks/:id/cancel",
  handler: async (req) => {
    const id = String(req.params?.id ?? "").trim();
    const cancelled = cancelTask(id);
    if (!cancelled) {
      return jsonResponse(409, {
        status: "error",
        error: "Task not found or already terminal"
      });
    }

    return jsonResponse(200, {
      status: "ok",
      cancelled: true
    });
  }
});
