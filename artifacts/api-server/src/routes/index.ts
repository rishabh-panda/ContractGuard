import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import contractRouter from "./contract.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(contractRouter);

export default router;
