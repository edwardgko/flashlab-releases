import { supabase } from './supabaseClient.js'

// íconos-imagen que el usuario ya subió alguna vez (página o grupo de chat) —
// se guardan en el server (custom_icons, migración 0022) para poder
// reusarlos desde una sección "Personalizados" en el picker, por CUENTA —
// antes vivían en localStorage, que es por instalación de Electron, no por
// cuenta: cambiar de usuario en la misma máquina seguía mostrando los
// personalizados del anterior. Solo URLs (nunca los bytes), mismo criterio
// que page.icon: liviano y ya listo para un <img src>.
const MAX_ICONS = 40

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

export async function getCustomIcons() {
  const userId = await currentUserId()
  if (!userId) return []
  const { data, error } = await supabase
    .from('custom_icons')
    .select('url')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_ICONS)
  if (error) {
    console.error('no se pudieron cargar los íconos personalizados:', error)
    return []
  }
  return data.map((row) => row.url)
}

// más reciente primero, sin duplicados — subir de nuevo un ícono ya
// guardado solo lo trae al frente de la lista (upsert por user_id+url).
export async function addCustomIcon(url) {
  if (typeof url !== 'string' || !url) return
  const userId = await currentUserId()
  if (!userId) return
  const { error } = await supabase
    .from('custom_icons')
    .upsert({ user_id: userId, url, created_at: new Date().toISOString() }, { onConflict: 'user_id,url' })
  if (error) {
    console.error('no se pudo guardar el ícono personalizado:', error)
    return
  }
  // podar más allá de MAX_ICONS — barato: como mucho corre cada vez que se
  // sube un ícono nuevo, nunca en el camino de lectura.
  const { data: rows } = await supabase
    .from('custom_icons')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  const excessIds = (rows ?? []).slice(MAX_ICONS).map((row) => row.id)
  if (excessIds.length) await supabase.from('custom_icons').delete().in('id', excessIds)
}

export async function deleteCustomIcon(url) {
  const userId = await currentUserId()
  if (!userId) return
  const { error } = await supabase.from('custom_icons').delete().eq('user_id', userId).eq('url', url)
  if (error) console.error('no se pudo borrar el ícono personalizado:', error)
}
