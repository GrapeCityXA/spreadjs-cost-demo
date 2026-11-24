import { API_BASE_URL } from '@/api/base'
import '../template/managedFunctions'
// 导入 SpreadJS GC 对象并挂载到全局
import GC from "@grapecity-software/spread-sheets";
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css'
import '../utils/spreadjsLicense'
window.GC = GC;



// 全局注册 QUERY 自定义函数
var QueryFunction = function () {};
QueryFunction.prototype = new GC.Spread.CalcEngine.Functions.AsyncFunction(
  "QUERY",
  5,
  5,
  {
    description: "查询并返回指定模板的数据",
    parameters: [
      { name: "模板ID" },
      { name: "月份" },
      { name: "项目1" },
      { name: "项目2" },
      { name: "字段名称" },
    ],
  },
);
QueryFunction.prototype.defaultValue = function () {
  return "查询中...";
};
QueryFunction.prototype.evaluateAsync = function (context) {
  var args = Array.prototype.slice.call(arguments, 1);
  var templateId = args[0];
  var month = args[1];
  var project1 = args[2];
  var project2 = args[3];
  var fields = args[4];

  if (!templateId || !month || !project1 || !project2 || !fields) {
    context.setAsyncResult("#INVALID_ARGS");
    return;
  }

  var token = localStorage.getItem("token");
  if (!token) {
    context.setAsyncResult("#AUTH_ERROR");
    return;
  }

  var params = new URLSearchParams({
    templateId: String(templateId),
    month: String(month),
    project1: String(project1),
    project2: String(project2),
    fields: String(fields),
  });

  fetch(`${API_BASE_URL}/data/query?${params}`, {
    headers: {
      Authorization: "Bearer " + token,
    },
  })
    .then(function (response) {
      if (!response.ok) {
        return "#ERROR_" + response.status;
      }
      return response.json();
    })
    .then(function (data) {
      if (data.data && data.data.length > 0) {
        var result = data.data[0][fields];
        context.setAsyncResult(
          result !== undefined && result !== null ? String(result) : "#NO_DATA",
        );
      } else {
        context.setAsyncResult("#NO_DATA");
      }
    })
    .catch(function (error) {
      console.error("QUERY function error:", error);
      context.setAsyncResult("#ERROR: " + error.message);
    });
};
QueryFunction.prototype.evaluateMode = function () {
  return GC.Spread.CalcEngine.Functions.AsyncFunctionEvaluateMode
    .onRecalculation;
};

// 使用全局注册，所有工作簿/工作表都可以使用
GC.Spread.CalcEngine.Functions.defineGlobalCustomFunction(
  "QUERY",
  new QueryFunction(),
);

