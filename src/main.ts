import { AppController } from './ui/app'

const root = document.getElementById('app')
if (!root) throw new Error('#app not found')
new AppController(root)
