import 'zone.js'
import '@angular/compiler'
import { enableProdMode } from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import { AppComponent } from './app.component'
import './styles.css'

enableProdMode()
bootstrapApplication(AppComponent).catch(() => {
    document.body.textContent = '界面无法启动。请重新打开应用。'
})
