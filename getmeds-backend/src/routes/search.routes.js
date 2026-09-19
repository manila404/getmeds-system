const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/search.controller');

router.use(requireAuth);
router.get('/', c.search);

module.exports = router;
