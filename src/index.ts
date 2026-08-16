import { applyHome } from './home'
import { serve } from './serve'

applyHome()

serve().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
