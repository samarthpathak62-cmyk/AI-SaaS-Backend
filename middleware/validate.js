// Usage: router.post('/x', validate(schemas.login), handler)
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))
      });
    }
    req.body = result.data; // use the parsed/coerced version
    next();
  };
}

module.exports = { validate };
