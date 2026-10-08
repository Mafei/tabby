import './web-platform'
import 'zone.js'
import { enableProdMode, provideZoneChangeDetection } from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import { AppComponent } from './app.component'

enableProdMode()
bootstrapApplication(AppComponent, { providers: [provideZoneChangeDetection()] }).catch(() => {
    document.body.textContent = '界面无法启动。请重新打开应用。'
})
