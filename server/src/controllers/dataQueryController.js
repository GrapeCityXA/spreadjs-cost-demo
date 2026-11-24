const db = require('../config/database');

// 查询tableData数据
exports.queryTableData = (req, res) => {
  const { templateId, month, project1, project2, fields } = req.query;
  const userId = req.user.id;

  // 验证必填参数
  if (!templateId || !month) {
    return res.status(400).json({ error: '模板ID和月份为必填参数' });
  }

  // 根据模板ID和月份查找对应的报表
  db.get(
    'SELECT * FROM reports WHERE template_id = ? AND period = ?',
    [templateId, month],
    (err, report) => {
      if (err) {
        return res.status(500).json({ error: '查询报表失败' });
      }

      if (!report) {
        return res.status(404).json({ error: '未找到对应的报表数据' });
      }

      // 权限检查：只能查询已完成的报表或自己创建的报表
      const hasReviewPermission = req.user.permissions.includes('review');
      const isViewOnly = req.user.permissions.length === 1 && req.user.permissions.includes('view');
      const canAccess = hasReviewPermission ||
                       report.created_by === userId ||
                       (isViewOnly && report.status === 'completed');

      if (!canAccess) {
        return res.status(403).json({ error: '无权访问此报表数据' });
      }

      // 获取数据源
      db.get(
        'SELECT * FROM datasources WHERE id = ?',
        [report.datasource_id],
        (err, datasource) => {
          if (err) {
            return res.status(500).json({ error: '获取数据源失败' });
          }

          if (!datasource) {
            return res.status(404).json({ error: '数据源不存在' });
          }

          try {
            const data = JSON.parse(datasource.data);
            let result = data.costData || [];

            // 按project1过滤
            if (project1) {
              result = result.filter(item => item.project1 === project1);
            }

            // 按project2过滤
            if (project2) {
              result = result.filter(item => item.project2 === project2);
            }

            // 选择需要的字段
            if (fields) {
              const fieldList = fields.split(',');
              result = result.map(item => {
                const selected = {};
                fieldList.forEach(field => {
                  if (field in item) {
                    selected[field] = item[field];
                  }
                });
                return selected;
              });
            }

            res.json({
              templateId,
              month,
              reportId: report.id,
              data: result,
              total: result.length
            });
          } catch (error) {
            return res.status(500).json({ error: '解析数据失败' });
          }
        }
      );
    }
  );
};
