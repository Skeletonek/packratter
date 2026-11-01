import { FastifyPluginAsync } from 'fastify';
import { scanToolchain } from '../../lib/toolchain.js';

const toolchainRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    return { success: true, data: await scanToolchain() };
  });
};

export default toolchainRoutes;
